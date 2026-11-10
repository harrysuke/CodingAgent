import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent, AuthResult, BrowseResult, HealthResponse, InstallSkillResult, ResolveAttachmentsResult,
  SkillsResponse, TerminalChunk, TerminalState, WorkspaceInfo, WorkspaceState,
} from '@codingagent/shared';
import {
  ChangePasswordSchema, ChatRequestSchema, CreateKeySchema, CreateSessionSchema, InstallSkillSchema,
  LoginSchema, OpenWorkspaceSchema, PermissionResolveSchema, RegisterSchema, ResolveAttachmentsSchema,
  SettingsSchema, ToggleSkillSchema, UpdateSessionSchema,
} from '@codingagent/shared';
import { env } from '../env';
import { getDb } from '../db/client';
import {
  addApiKey, createProject, createSession, deleteApiKey, deleteSession, getAnalytics, getApiKeys,
  getActiveProject, getFileChanges, getMessages, getModels, getProviderInfos, getProject, getSession,
  getSettings, getTodos, listProjects, listSessions, pendingPermissions, sessionOwner, setApiKeyEnabled,
  setSettings, setActiveProjectId, updateSession,
} from '../db/repo';
import { abortRun, isRunning, runAgent } from '../agent/loop';
import { recentEvents, subscribe } from '../agent/bus';
import { settle } from '../agent/permissions';
import { listDir, readFile, tree } from '../workspace/files';
import {
  activeRoot, activeWorkspace, assertAllowedRoot, browse, openWorkspace, recentWorkspaces,
  registerWorkspaceFolder, safeRoot, sessionProject, sessionRoot, sessionWorkspace, userHome,
} from '../workspace/registry';
import { resolveAttachments } from '../workspace/attachments';
import {
  installSkill, listSkills, removeSkill, setSkillEnabled, skillDirectories,
} from '../skills/registry';
import {
  clearTerminalBuffer, createTerminal, disposeTerminal, getTerminal, interruptTerminal,
  listTerminals, subscribeTerminal, terminalBacklog, writeTerminal,
} from '../terminal/manager';
import type { Actor } from '../auth/service';
import {
  AuthError, authStatus, changePassword, currentUser, login, logout, register, verifySession,
} from '../auth/service';

class BadRequest extends Error {}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

/** Endpoints that must work before a session exists. Everything else needs one. */
const PUBLIC_API = new Set([
  '/api/health', '/api/auth/status', '/api/auth/login', '/api/auth/register',
]);

/** Query param / X-Agent-Token are kept for SSE and mobile WebViews. */
function bearer(c: any): string {
  return c.req.header('Authorization')?.replace(/^Bearer\s+/i, '')
    || c.req.header('X-Agent-Token')
    || c.req.query('token')
    || '';
}

const actorOf = (c: any): Actor => c.get('actor') as Actor;

function authFailure(c: any, err: unknown) {
  if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
  return c.json({ error: (err as Error).message }, 400);
}

/** Hono context variables populated by the auth middleware. */
interface AppVariables {
  actor: Actor;
}

export function createApp() {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-Token'],
  }));

  // A bearer token is now a per-account session, not the shared AGENT_TOKEN.
  // AGENT_TOKEN is only the one-time setup secret for the first admin account.
  app.use('/api/*', async (c, next) => {
    const actor = verifySession(bearer(c));
    if (PUBLIC_API.has(c.req.path)) {
      if (actor) c.set('actor', actor);
      await next();
      return;
    }
    if (!actor) return c.json({ error: 'Sign in to use CodingAgent. Each account uses its own API keys.' }, 401);
    c.set('actor', actor);
    await next();
  });

  const parse = async <T>(c: any, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }): Promise<T> => {
    let body: unknown;
    try { body = await c.req.json(); } catch { body = {}; }
    const result = schema.safeParse(body);
    if (!result.success) throw new BadRequest(result.error.issues.map(i => i.message).join('; '));
    return result.data;
  };

  /** Session ownership gate for routes keyed by a session id. */
  const ownsSession = (c: any, sessionId: string, actor: Actor): boolean =>
    !!sessionId && !!getSession(sessionId, actor.userId);

  // -----------------------------------------------------------------------
  // Accounts / login / BYOK
  // -----------------------------------------------------------------------
  app.get('/api/auth/status', c => c.json(authStatus()));

  app.post('/api/auth/register', async c => {
    const body = await parse(c, RegisterSchema);
    try {
      const result: AuthResult = register(body);
      return c.json(result, 201);
    } catch (err) { return authFailure(c, err); }
  });

  app.post('/api/auth/login', async c => {
    const body = await parse(c, LoginSchema);
    try {
      const result: AuthResult = login(body);
      return c.json(result);
    } catch (err) { return authFailure(c, err); }
  });

  app.post('/api/auth/logout', c => { logout(bearer(c)); return c.json({ ok: true }); });

  app.get('/api/auth/me', c => c.json(currentUser(actorOf(c).userId)));

  app.post('/api/auth/password', async c => {
    const body = await parse(c, ChangePasswordSchema);
    try { return c.json(changePassword(actorOf(c).userId, body.current, body.next)); }
    catch (err) { return authFailure(c, err); }
  });

  // -----------------------------------------------------------------------
  // Health — public but deliberately sparse until a session is attached
  // -----------------------------------------------------------------------
  app.get('/api/health', (c) => {
    const db = getDb();
    const models = (db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n;
    const actor = c.get('actor') as Actor | undefined;
    const sessionId = c.req.query('sessionId');
    // When the client is looking at a session, report THAT session's folder
    // rather than the account-wide default (it may differ per session).
    const project = actor
      ? (sessionId ? sessionProject(sessionId, actor) : getActiveProject(actor.userId))
      : null;
    const payload: HealthResponse = {
      ok: true, name: 'CodingAgent', version: '0.1.0',
      dbPath: actor ? env.dbPath : '',
      models,
      providersConfigured: actor ? getProviderInfos(actor.userId).filter(p => p.configured).length : 0,
      workspaceRoot: actor ? (sessionId ? sessionRoot(sessionId, actor) : activeRoot(actor)) : '',
      workspaceName: project?.name,
      projectId: project?.id,
      authenticated: !!actor,
      requiresAuth: true,
      // Capability flag: the UI uses this to detect a stale server that would
      // silently ignore per-session folder binding.
      sessionWorkspaces: true,
    };
    return c.json(payload);
  });

  // -----------------------------------------------------------------------
  // Live event stream (SSE)
  // -----------------------------------------------------------------------
  app.get('/api/sessions/:id/events', async (c) => {
    const sessionId = c.req.param('id');
    if (!ownsSession(c, sessionId, actorOf(c))) return c.json({ error: 'Session not found' }, 404);
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      let closed = false;
      const write = (event: AgentEvent) => {
        if (closed) return;
        void stream.writeSSE({ data: JSON.stringify(event), event: event.type }).catch(() => {});
      };
      const unsubscribe = subscribe(sessionId, write);
      stream.onAbort(() => { closed = true; unsubscribe(); });

      // The client loads authoritative state from REST on connect, so only
      // replay buffered deltas when it explicitly asks for them (avoids
      // doubling text after a reconnect).
      if (c.req.query('replay') === '1') {
        for (const event of recentEvents(sessionId)) write(event);
      }
      await stream.writeSSE({ data: JSON.stringify({ sessionId }), event: 'ready' });

      while (!closed) {
        await stream.sleep(15_000);
        if (closed) break;
        await stream.writeSSE({ data: String(Date.now()), event: 'ping' }).catch(() => { closed = true; });
      }
      unsubscribe();
    });
  });

  // -----------------------------------------------------------------------
  // Projects & sessions
  // -----------------------------------------------------------------------
  app.get('/api/projects', c => c.json(listProjects(actorOf(c).userId)));
  app.post('/api/projects', async c => {
    const actor = actorOf(c);
    const body = await c.req.json().catch(() => ({})) as { name?: string; rootPath?: string };
    if (!body.rootPath) return c.json({ error: 'rootPath is required' }, 400);
    // A project root becomes a file-tool sandbox root, so it must pass the
    // same confinement check as opening a workspace.
    let root: string;
    try { root = assertAllowedRoot(actor, body.rootPath); }
    catch (err) { return c.json({ error: (err as Error).message }, 403); }
    const project = createProject(body.name || path.basename(root), root, actor.userId);
    // Creating a project is the same user intent as opening a workspace.
    setActiveProjectId(project.id, actor.userId);
    return c.json(project, 201);
  });

  app.get('/api/sessions', c => c.json(listSessions(actorOf(c).userId, c.req.query('projectId'))));
  app.post('/api/sessions', async c => {
    const actor = actorOf(c);
    const body = await parse(c, CreateSessionSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    if (body.rootPath) {
      // A folder picked for a new session becomes that session's own project
      // directory. It is deliberately NOT made the account's active pointer:
      // existing sessions must keep the folders they were created with.
      try {
        const project = registerWorkspaceFolder(body.rootPath, undefined, actor);
        const created = createSession(actor.userId, {
          projectId: project.id, title: body.title, agent: body.agent,
        });
        // Echo the resolved folder. The UI treats a missing `workspaceRoot` as
        // proof that the running server is an older build which silently dropped
        // `rootPath` and bound the session to the account pointer instead.
        return c.json({ ...created, workspaceRoot: project.rootPath }, 201);
      } catch (err) {
        return c.json({ error: (err as Error).message }, 400);
      }
    }
    // With no explicit folder, a session must NOT inherit the account-wide
    // active pointer: that pointer belongs to whichever session last opened a
    // workspace, so inheriting it is how a new session used to write files
    // into an older session's directory. Bind it to the account's own home.
    if (!body.projectId) {
      const home = userHome(actor);
      const project = registerWorkspaceFolder(home, path.basename(home) || 'workspace', actor);
      return c.json(createSession(actor.userId, {
        ...body, projectId: project.id,
      }), 201);
    }
    return c.json(createSession(actor.userId, body), 201);
  });

  app.get('/api/sessions/:id', c => {
    const actor = actorOf(c);
    const session = getSession(c.req.param('id'), actor.userId);
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json({ session, messages: getMessages(session.id), todos: getTodos(session.id), running: isRunning(session.id) });
  });

  app.patch('/api/sessions/:id', async c => {
    const body = await parse(c, UpdateSessionSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const updated = updateSession(actorOf(c).userId, c.req.param('id'), body);
    return updated ? c.json(updated) : c.json({ error: 'Session not found' }, 404);
  });

  app.delete('/api/sessions/:id', c => {
    const actor = actorOf(c);
    const id = c.req.param('id');
    if (!ownsSession(c, id, actor)) return c.json({ deleted: false });
    abortRun(id);
    return c.json({ deleted: deleteSession(id, actor.userId) });
  });

  app.post('/api/sessions/:id/chat', async c => {
    const actor = actorOf(c);
    const sessionId = c.req.param('id');
    if (!ownsSession(c, sessionId, actor)) return c.json({ error: 'Session not found' }, 404);
    if (isRunning(sessionId)) return c.json({ error: 'A response is already streaming for this session' }, 409);
    const body = await parse(c, ChatRequestSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    void runAgent({ sessionId, request: body, actor });
    return c.json({ started: true, sessionId }, 202);
  });

  app.post('/api/sessions/:id/abort', c => {
    const id = c.req.param('id');
    if (!ownsSession(c, id, actorOf(c))) return c.json({ error: 'Session not found' }, 404);
    return c.json({ aborted: abortRun(id) });
  });

  // -----------------------------------------------------------------------
  // Permissions
  // -----------------------------------------------------------------------
  app.get('/api/sessions/:id/permissions', c => {
    const id = c.req.param('id');
    if (!ownsSession(c, id, actorOf(c))) return c.json({ error: 'Session not found' }, 404);
    return c.json(pendingPermissions(id));
  });
  app.post('/api/permissions/:id/resolve', async c => {
    const body = await parse(c, PermissionResolveSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const updated = settle(c.req.param('id'), body.decision, actorOf(c).userId);
    return updated ? c.json(updated) : c.json({ error: 'Permission request not found or already resolved' }, 404);
  });

  // -----------------------------------------------------------------------
  // Model catalog / providers / keys — every key query is account-scoped
  // -----------------------------------------------------------------------
  app.get('/api/models', c => c.json(getModels(actorOf(c).userId)));
  app.get('/api/providers', c => c.json(getProviderInfos(actorOf(c).userId)));
  app.get('/api/keys', c => c.json(getApiKeys(actorOf(c).userId)));
  app.post('/api/keys', async c => {
    const body = await parse(c, CreateKeySchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    try { return c.json(addApiKey(actorOf(c).userId, body), 201); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.patch('/api/keys/:id', async c => {
    const actor = actorOf(c);
    const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400);
    setApiKeyEnabled(actor.userId, Number(c.req.param('id')), body.enabled);
    return c.json(getApiKeys(actor.userId));
  });
  app.delete('/api/keys/:id', c => c.json({ deleted: deleteApiKey(actorOf(c).userId, Number(c.req.param('id'))) }));

  // -----------------------------------------------------------------------
  // Settings / telemetry
  // -----------------------------------------------------------------------
  app.get('/api/settings', c => c.json(getSettings(actorOf(c).userId)));
  app.patch('/api/settings', async c => {
    const body = await parse(c, SettingsSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    return c.json(setSettings(actorOf(c).userId, body));
  });
  app.get('/api/analytics', c => c.json(getAnalytics(actorOf(c).userId)));

  // -----------------------------------------------------------------------
  // Workspace: the sandboxed project home the agent is bound to
  // -----------------------------------------------------------------------
  /** Root for an explicit session id, falling back to the account pointer. */
  const rootForSession = (sessionId: string | undefined, actor: Actor): string =>
    sessionId ? sessionRoot(sessionId, actor) : activeRoot(actor);

  const rootFor = (c: any, actor: Actor): string => {
    // File browsing is session-scoped: the tree/content of a session must
    // come from that session's folder, not from whichever folder was last
    // opened somewhere else in the account.
    const sessionId = c.req.query('sessionId');
    if (sessionId) return rootForSession(sessionId, actor);
    const projectId = c.req.query('projectId');
    if (projectId) {
      const project = getProject(projectId, actor.userId);
      // Re-clamp even a user-owned row: file tools must never inherit a root
      // that points (or symlinks) outside a confined account's sandbox.
      if (project?.rootPath) return safeRoot(actor, project.rootPath);
    }
    return activeRoot(actor);
  };

  app.get('/api/workspace', (c) => {
    const actor = actorOf(c);
    const sessionId = c.req.query('sessionId');
    const payload: WorkspaceState = {
      // Each session reports its own folder. Without a sessionId the legacy
      // account-wide active workspace is returned for older clients.
      active: sessionId ? sessionWorkspace(sessionId, actor) : activeWorkspace(actor),
      recent: recentWorkspaces(actor),
      defaultRoot: actor.isAdmin ? env.workspaceRoot : actor.homeRoot,
    };
    return c.json(payload);
  });

  app.get('/api/workspace/browse', (c) => {
    try {
      const result: BrowseResult = browse(c.req.query('path'), actorOf(c));
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/api/workspace/open', async (c) => {
    const actor = actorOf(c);
    const body = await parse(c, OpenWorkspaceSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    if (body.sessionId && !ownsSession(c, body.sessionId, actor)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    try {
      const info: WorkspaceInfo = openWorkspace(body.path, body.name, actor, { sessionId: body.sessionId });
      return c.json(info);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // -----------------------------------------------------------------------
  // Attachments: explicit context pinned to a single turn
  // -----------------------------------------------------------------------
  app.post('/api/attachments/resolve', async (c) => {
    const actor = actorOf(c);
    const body = await parse(c, ResolveAttachmentsSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    if (body.sessionId && !ownsSession(c, body.sessionId, actor)) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const root = rootForSession(body.sessionId, actor);
    const result: ResolveAttachmentsResult = resolveAttachments(root, body.paths, actor);
    return c.json(result);
  });

  // -----------------------------------------------------------------------
  // Agent Skills (installed through the terminal, injected into the prompt)
  // -----------------------------------------------------------------------
  const skillsPayload = (root: string): SkillsResponse => ({
    skills: listSkills(root),
    directories: skillDirectories(root),
  });

  /** Skill ids contain a colon (`workspace:slug`), which clients URL-encode. */
  const skillId = (c: any): string => {
    const raw = c.req.param('id') ?? '';
    try { return decodeURIComponent(raw); } catch { return raw; }
  };

  app.get('/api/skills', (c) => c.json(skillsPayload(rootForSession(c.req.query('sessionId'), actorOf(c)))));

  app.post('/api/skills/install', async (c) => {
    const actor = actorOf(c);
    const body = await parse(c, InstallSkillSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const root = rootForSession(body.sessionId, actor);
    try {
      const result: InstallSkillResult = await installSkill(root, body);
      return c.json(result, result.installed.length ? 201 : 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch('/api/skills/:id', async (c) => {
    const actor = actorOf(c);
    const body = await parse(c, ToggleSkillSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const root = rootForSession(body.sessionId, actor);
    const updated = setSkillEnabled(root, skillId(c), body.enabled);
    return updated ? c.json(skillsPayload(root)) : c.json({ error: 'Skill not found' }, 404);
  });

  app.delete('/api/skills/:id', (c) => {
    const actor = actorOf(c);
    const root = rootForSession(c.req.query('sessionId'), actor);
    const removed = removeSkill(root, skillId(c));
    return removed ? c.json(skillsPayload(root)) : c.json({ error: 'Skill not found' }, 404);
  });

  // -----------------------------------------------------------------------
  // Terminal: a persistent shell in the account's workspace root
  // -----------------------------------------------------------------------
  app.get('/api/terminal', c => c.json(listTerminals(actorOf(c).userId)));

  app.post('/api/terminal', async (c) => {
    const actor = actorOf(c);
    if (!actor.allowShell) {
      return c.json({ error: 'Shell access is disabled for this account. Ask the administrator to enable AGENT_ALLOW_USER_SHELL.' }, 403);
    }
    const body = await c.req.json().catch(() => ({})) as { sessionId?: string };
    try {
      // The shell is spawned once and keeps its cwd, so start it in the folder
      // belonging to the session that opened the terminal.
      const state: TerminalState = createTerminal(rootForSession(body.sessionId, actor), actor.userId);
      return c.json(state, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get('/api/terminal/:id/events', async (c) => {
    const actor = actorOf(c);
    const id = c.req.param('id');
    if (!getTerminal(id, actor.userId)) return c.json({ error: 'Terminal not found' }, 404);
    c.header('Content-Type', 'text/event-stream');
    c.header('Cache-Control', 'no-cache, no-transform');
    c.header('Connection', 'keep-alive');
    c.header('X-Accel-Buffering', 'no');

    return streamSSE(c, async (stream) => {
      let closed = false;
      const write = (chunk: TerminalChunk) => {
        if (closed) return;
        void stream.writeSSE({ data: JSON.stringify(chunk), event: 'chunk' }).catch(() => {});
      };
      // Replay the scrollback so a reconnecting UI is not left with a blank shell.
      for (const chunk of terminalBacklog(id, actor.userId)) write(chunk);
      const unsubscribe = subscribeTerminal(id, write, actor.userId);
      if (!unsubscribe) { closed = true; return; }
      stream.onAbort(() => { closed = true; unsubscribe(); });
      await stream.writeSSE({ data: JSON.stringify({ terminalId: id }), event: 'ready' });

      while (!closed) {
        await stream.sleep(15_000);
        if (closed) break;
        await stream.writeSSE({ data: String(Date.now()), event: 'ping' }).catch(() => { closed = true; });
      }
      unsubscribe();
    });
  });

  app.post('/api/terminal/:id/input', async (c) => {
    const body = await c.req.json().catch(() => ({})) as { data?: string };
    if (typeof body.data !== 'string') return c.json({ error: 'data must be a string' }, 400);
    return writeTerminal(c.req.param('id'), body.data, actorOf(c).userId)
      ? c.json({ ok: true })
      : c.json({ error: 'Terminal not found' }, 404);
  });

  app.post('/api/terminal/:id/interrupt', c => c.json({ ok: interruptTerminal(c.req.param('id'), actorOf(c).userId) }));
  app.post('/api/terminal/:id/clear', c => c.json({ ok: clearTerminalBuffer(c.req.param('id'), actorOf(c).userId) }));
  app.delete('/api/terminal/:id', c => c.json({ deleted: disposeTerminal(c.req.param('id'), actorOf(c).userId) }));

  // -----------------------------------------------------------------------
  // Workspace file browsing
  // -----------------------------------------------------------------------
  app.get('/api/files/tree', c => {
    const actor = actorOf(c);
    const root = rootFor(c, actor);
    try {
      const depth = Number.parseInt(c.req.query('depth') ?? '2', 10);
      const entries = depth > 1 ? tree(root, c.req.query('path') ?? '.', Math.min(depth, 5)) : listDir(root, c.req.query('path') ?? '.');
      return c.json({ entries, root });
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  app.get('/api/files/content', c => {
    const rel = c.req.query('path');
    if (!rel) return c.json({ error: 'path is required' }, 400);
    try {
      return c.json(readFile(rootFor(c, actorOf(c)), rel, 1, 4000));
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  app.get('/api/files/changes', c => {
    const actor = actorOf(c);
    const id = c.req.query('sessionId') ?? '';
    if (!id || sessionOwner(id) !== actor.userId) return c.json([], 403);
    return c.json(getFileChanges(id));
  });
  app.get('/api/todos', c => {
    const actor = actorOf(c);
    const id = c.req.query('sessionId') ?? '';
    if (!id || sessionOwner(id) !== actor.userId) return c.json([], 403);
    return c.json(getTodos(id));
  });

  // -----------------------------------------------------------------------
  // Static UI (desktop / single-origin production build)
  // -----------------------------------------------------------------------
  const webDist = path.resolve(env.root, 'apps/web/dist');
  app.get('/*', (c) => {
    const urlPath = c.req.path;
    if (urlPath.startsWith('/api/')) return c.json({ error: `Not found: ${urlPath}` }, 404);
    const candidate = path.resolve(webDist, '.' + urlPath);
    if (urlPath !== '/' && candidate.startsWith(webDist) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return new Response(fs.readFileSync(candidate), {
        headers: { 'Content-Type': MIME[path.extname(candidate)] ?? 'application/octet-stream' },
      });
    }
    const index = path.join(webDist, 'index.html');
    if (fs.existsSync(index)) return c.html(fs.readFileSync(index, 'utf8'));
    return c.html('<!doctype html><title>CodingAgent</title><p>UI not built. Run <code>npm run build -w @codingagent/web</code>, or use the Vite dev server on port 5173.</p>');
  });

  app.notFound(c => c.json({ error: `Not found: ${c.req.path}` }, 404));
  app.onError((err, c) => {
    if (err instanceof BadRequest) return c.json({ error: err.message }, 400);
    if (err instanceof AuthError) return c.json({ error: err.message }, err.status);
    console.error('[http]', err);
    return c.json({ error: (err as Error).message }, 500);
  });

  return app;
}
