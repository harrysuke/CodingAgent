import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentEvent, BrowseResult, HealthResponse, InstallSkillResult, ResolveAttachmentsResult,
  SkillsResponse, TerminalChunk, TerminalState, WorkspaceInfo, WorkspaceState,
} from '@codingagent/shared';
import {
  ChatRequestSchema, CreateKeySchema, CreateSessionSchema, InstallSkillSchema, OpenWorkspaceSchema,
  PermissionResolveSchema, ResolveAttachmentsSchema, SettingsSchema, ToggleSkillSchema, UpdateSessionSchema,
} from '@codingagent/shared';
import { env } from '../env';
import { getDb } from '../db/client';
import {
  addApiKey, createProject, createSession, deleteApiKey, deleteSession, getAnalytics, getApiKeys,
  getActiveProject, getFileChanges, getMessages, getModels, getProviderInfos, getSession, getSettings,
  getTodos, listProjects, listSessions, pendingPermissions, setApiKeyEnabled, setSettings,
  setActiveProjectId, updateSession,
} from '../db/repo';
import { abortRun, isRunning, runAgent } from '../agent/loop';
import { recentEvents, subscribe } from '../agent/bus';
import { settle } from '../agent/permissions';
import { listDir, readFile, tree } from '../workspace/files';
import { getProject } from '../db/repo';
import { activeRoot, activeWorkspace, browse, openWorkspace, recentWorkspaces } from '../workspace/registry';
import { resolveAttachments } from '../workspace/attachments';
import {
  installSkill, listSkills, removeSkill, setSkillEnabled, skillDirectories,
} from '../skills/registry';
import {
  clearTerminalBuffer, createTerminal, disposeTerminal, getTerminal, interruptTerminal,
  listTerminals, subscribeTerminal, terminalBacklog, writeTerminal,
} from '../terminal/manager';

class BadRequest extends Error {}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
};

export function createApp() {
  const app = new Hono();

  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Agent-Token'],
  }));

  // Shared secret. Query param is allowed so EventSource-style clients and
  // mobile WebViews can authenticate without custom headers.
  app.use('/api/*', async (c, next) => {
    const header = c.req.header('Authorization')?.replace(/^Bearer\s+/i, '');
    const supplied = header || c.req.header('X-Agent-Token') || c.req.query('token') || '';
    if (supplied !== env.token) return c.json({ error: 'Unauthorized. Set the correct AGENT_TOKEN in Settings > Connection.' }, 401);
    await next();
  });

  const parse = async <T>(c: any, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false; error: { issues: { message: string }[] } } }): Promise<T> => {
    let body: unknown;
    try { body = await c.req.json(); } catch { body = {}; }
    const result = schema.safeParse(body);
    if (!result.success) throw new BadRequest(result.error.issues.map(i => i.message).join('; '));
    return result.data;
  };

  // -----------------------------------------------------------------------
  // Health
  // -----------------------------------------------------------------------
  app.get('/api/health', (c) => {
    const db = getDb();
    const models = (db.prepare('SELECT COUNT(*) AS n FROM models').get() as { n: number }).n;
    const providers = getProviderInfos().filter(p => p.configured).length;
    const project = getActiveProject();
    const payload: HealthResponse = {
      ok: true, name: 'CodingAgent', version: '0.1.0', dbPath: env.dbPath,
      models, providersConfigured: providers,
      workspaceRoot: activeRoot(),
      workspaceName: project?.name,
      projectId: project?.id,
    };
    return c.json(payload);
  });

  // -----------------------------------------------------------------------
  // Live event stream (SSE)
  // -----------------------------------------------------------------------
  app.get('/api/sessions/:id/events', async (c) => {
    const sessionId = c.req.param('id');
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
  app.get('/api/projects', c => c.json(listProjects()));
  app.post('/api/projects', async c => {
    const body = await c.req.json().catch(() => ({})) as { name?: string; rootPath?: string };
    if (!body.rootPath) return c.json({ error: 'rootPath is required' }, 400);
    const project = createProject(body.name || path.basename(body.rootPath), body.rootPath);
    // Creating a project is the same user intent as opening a workspace.
    setActiveProjectId(project.id);
    return c.json(project, 201);
  });

  app.get('/api/sessions', c => c.json(listSessions(c.req.query('projectId'))));
  app.post('/api/sessions', async c => {
    const body = await parse(c, CreateSessionSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    return c.json(createSession(body), 201);
  });

  app.get('/api/sessions/:id', c => {
    const session = getSession(c.req.param('id'));
    if (!session) return c.json({ error: 'Session not found' }, 404);
    return c.json({ session, messages: getMessages(session.id), todos: getTodos(session.id), running: isRunning(session.id) });
  });

  app.patch('/api/sessions/:id', async c => {
    const body = await parse(c, UpdateSessionSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const updated = updateSession(c.req.param('id'), body);
    return updated ? c.json(updated) : c.json({ error: 'Session not found' }, 404);
  });

  app.delete('/api/sessions/:id', c => {
    abortRun(c.req.param('id'));
    return c.json({ deleted: deleteSession(c.req.param('id')) });
  });

  app.post('/api/sessions/:id/chat', async c => {
    const sessionId = c.req.param('id');
    if (!getSession(sessionId)) return c.json({ error: 'Session not found' }, 404);
    if (isRunning(sessionId)) return c.json({ error: 'A response is already streaming for this session' }, 409);
    const body = await parse(c, ChatRequestSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    void runAgent({ sessionId, request: body });
    return c.json({ started: true, sessionId }, 202);
  });

  app.post('/api/sessions/:id/abort', c => c.json({ aborted: abortRun(c.req.param('id')) }));

  // -----------------------------------------------------------------------
  // Permissions
  // -----------------------------------------------------------------------
  app.get('/api/sessions/:id/permissions', c => c.json(pendingPermissions(c.req.param('id'))));
  app.post('/api/permissions/:id/resolve', async c => {
    const body = await parse(c, PermissionResolveSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const updated = settle(c.req.param('id'), body.decision);
    return updated ? c.json(updated) : c.json({ error: 'Permission request not found or already resolved' }, 404);
  });

  // -----------------------------------------------------------------------
  // Model catalog / providers / keys (reused DB tables)
  // -----------------------------------------------------------------------
  app.get('/api/models', c => c.json(getModels()));
  app.get('/api/providers', c => c.json(getProviderInfos()));
  app.get('/api/keys', c => c.json(getApiKeys()));
  app.post('/api/keys', async c => {
    const body = await parse(c, CreateKeySchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    try { return c.json(addApiKey(body), 201); }
    catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });
  app.patch('/api/keys/:id', async c => {
    const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
    if (typeof body.enabled !== 'boolean') return c.json({ error: 'enabled must be a boolean' }, 400);
    setApiKeyEnabled(Number(c.req.param('id')), body.enabled);
    return c.json(getApiKeys());
  });
  app.delete('/api/keys/:id', c => c.json({ deleted: deleteApiKey(Number(c.req.param('id'))) }));

  // -----------------------------------------------------------------------
  // Settings / telemetry
  // -----------------------------------------------------------------------
  app.get('/api/settings', c => c.json(getSettings()));
  app.patch('/api/settings', async c => {
    const body = await parse(c, SettingsSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    return c.json(setSettings(body));
  });
  app.get('/api/analytics', c => c.json(getAnalytics()));

  // -----------------------------------------------------------------------
  // Workspace: the sandboxed project home the agent is bound to
  // -----------------------------------------------------------------------
  const rootFor = (c: any): string => {
    const projectId = c.req.query('projectId');
    if (projectId) {
      const project = getProject(projectId);
      if (project?.rootPath) return project.rootPath;
    }
    return activeRoot();
  };

  const rootForSession = (sessionId?: string): string => {
    if (!sessionId) return activeRoot();
    const session = getSession(sessionId);
    const project = session ? getProject(session.projectId) : null;
    return project?.rootPath?.trim() ? project.rootPath : activeRoot();
  };

  app.get('/api/workspace', (c) => {
    const payload: WorkspaceState = {
      active: activeWorkspace(),
      recent: recentWorkspaces(),
      defaultRoot: env.workspaceRoot,
    };
    return c.json(payload);
  });

  app.get('/api/workspace/browse', (c) => {
    try {
      const result: BrowseResult = browse(c.req.query('path'));
      return c.json(result);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.post('/api/workspace/open', async (c) => {
    const body = await parse(c, OpenWorkspaceSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    try {
      const info: WorkspaceInfo = openWorkspace(body.path, body.name);
      return c.json(info);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  // -----------------------------------------------------------------------
  // Attachments: explicit context pinned to a single turn
  // -----------------------------------------------------------------------
  app.post('/api/attachments/resolve', async (c) => {
    const body = await parse(c, ResolveAttachmentsSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const root = rootForSession(body.sessionId);
    const result: ResolveAttachmentsResult = resolveAttachments(root, body.paths);
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

  app.get('/api/skills', (c) => c.json(skillsPayload(rootForSession(c.req.query('sessionId')))));

  app.post('/api/skills/install', async (c) => {
    const body = await parse(c, InstallSkillSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const root = rootForSession(body.sessionId);
    try {
      const result: InstallSkillResult = await installSkill(root, body);
      return c.json(result, result.installed.length ? 201 : 200);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400);
    }
  });

  app.patch('/api/skills/:id', async (c) => {
    const body = await parse(c, ToggleSkillSchema);
    if (!body) return c.json({ error: 'Invalid body' }, 400);
    const root = rootForSession(body.sessionId);
    const updated = setSkillEnabled(root, skillId(c), body.enabled);
    return updated ? c.json(skillsPayload(root)) : c.json({ error: 'Skill not found' }, 404);
  });

  app.delete('/api/skills/:id', (c) => {
    const root = rootForSession(c.req.query('sessionId'));
    const removed = removeSkill(root, skillId(c));
    return removed ? c.json(skillsPayload(root)) : c.json({ error: 'Skill not found' }, 404);
  });

  // -----------------------------------------------------------------------
  // Terminal: a persistent shell in the workspace root
  // -----------------------------------------------------------------------
  app.get('/api/terminal', c => c.json(listTerminals()));

  app.post('/api/terminal', (c) => {
    try {
      const state: TerminalState = createTerminal(activeRoot());
      return c.json(state, 201);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.get('/api/terminal/:id/events', async (c) => {
    const id = c.req.param('id');
    if (!getTerminal(id)) return c.json({ error: 'Terminal not found' }, 404);
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
      for (const chunk of terminalBacklog(id)) write(chunk);
      const unsubscribe = subscribeTerminal(id, write);
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
    return writeTerminal(c.req.param('id'), body.data)
      ? c.json({ ok: true })
      : c.json({ error: 'Terminal not found' }, 404);
  });

  app.post('/api/terminal/:id/interrupt', c => c.json({ ok: interruptTerminal(c.req.param('id')) }));
  app.post('/api/terminal/:id/clear', c => c.json({ ok: clearTerminalBuffer(c.req.param('id')) }));
  app.delete('/api/terminal/:id', c => c.json({ deleted: disposeTerminal(c.req.param('id')) }));

  // -----------------------------------------------------------------------
  // Workspace file browsing
  // -----------------------------------------------------------------------
  app.get('/api/files/tree', c => {
    try {
      const depth = Number.parseInt(c.req.query('depth') ?? '2', 10);
      const entries = depth > 1 ? tree(rootFor(c), c.req.query('path') ?? '.', Math.min(depth, 5)) : listDir(rootFor(c), c.req.query('path') ?? '.');
      return c.json({ entries, root: rootFor(c) });
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  app.get('/api/files/content', c => {
    const rel = c.req.query('path');
    if (!rel) return c.json({ error: 'path is required' }, 400);
    try {
      return c.json(readFile(rootFor(c), rel, 1, 4000));
    } catch (err) { return c.json({ error: (err as Error).message }, 400); }
  });

  app.get('/api/files/changes', c => c.json(getFileChanges(c.req.query('sessionId') ?? '')));
  app.get('/api/todos', c => c.json(getTodos(c.req.query('sessionId') ?? '')));

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
    console.error('[http]', err);
    return c.json({ error: (err as Error).message }, 500);
  });

  return app;
}
