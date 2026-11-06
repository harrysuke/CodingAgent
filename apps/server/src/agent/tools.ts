import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { AgentMode, Part, PermissionMode } from '@codingagent/shared';
import {
  appendPart, findPartByToolCall, getSettings, getTodos, recordFileChange, setTodos,
  updatePart,
} from '../db/repo';
import { editFile, glob, grep, listDir, readFile, tree, webfetch, writeFile } from '../workspace/files';
import { runShell } from '../workspace/shell';
import { resolveSafe } from '../workspace/paths';
import { listSkills } from '../skills/registry';
import { emit } from './bus';
import { checkPermission } from './permissions';

export interface ToolContext {
  sessionId: string;
  /** Account that owns this run: keys, settings and permission rows. */
  userId: string;
  /** False for non-admin accounts: a shell could `cd ..` out of the sandbox. */
  allowShell: boolean;
  assistantMessageId: string;
  root: string;
  agent: AgentMode;
  permissionMode: PermissionMode;
  signal: AbortSignal;
  /** Per-tool default arguments contributed by enabled Agent Skills. */
  toolDefaults?: Record<string, Record<string, unknown>>;
  /** When non-empty, only these tools are exposed to the model. */
  allowedTools?: string[];
}

type ToolResult = unknown;

export function createTools(ctx: ToolContext): ToolSet {
  const partCache = new Map<string, string>();

  /** Skill-provided defaults, used only when the model omitted the argument. */
  const defaultsFor = (toolName: string): Record<string, unknown> =>
    (ctx.toolDefaults?.[toolName] ?? {}) as Record<string, unknown>;
  const numberFrom = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const stringFrom = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value : undefined;

  function partFor(toolCallId: string, toolName: string, input: unknown): string {
    const cached = partCache.get(toolCallId);
    if (cached) return cached;
    const existing = findPartByToolCall(toolCallId);
    if (existing) { partCache.set(toolCallId, existing.id); return existing.id; }
    const part = appendPart(ctx.assistantMessageId, ctx.sessionId, {
      type: 'tool', toolCallId, toolName, state: 'pending', input,
    } as Partial<Part>);
    partCache.set(toolCallId, part.id);
    emit(ctx.sessionId, { type: 'part', part });
    return part.id;
  }

  async function run(
    toolCallId: string,
    toolName: string,
    input: unknown,
    action: () => Promise<ToolResult> | ToolResult,
    onChange?: (result: ToolResult) => void,
  ): Promise<ToolResult> {
    const partId = partFor(toolCallId, toolName, input);
    const permission = await checkPermission(
      { sessionId: ctx.sessionId, userId: ctx.userId, toolCallId, toolName, input, signal: ctx.signal },
      ctx.permissionMode, ctx.agent,
    );

    if (!permission.allowed) {
      const denied: ToolResult = { error: permission.reason ?? 'Permission denied', denied: true };
      updatePart(partId, { state: 'denied', input, output: denied });
      emit(ctx.sessionId, { type: 'part-state', partId, state: 'denied', output: denied });
      return denied;
    }

    updatePart(partId, { state: 'running', input });
    emit(ctx.sessionId, { type: 'part-state', partId, state: 'running' });

    try {
      const result = await action();
      updatePart(partId, { state: 'completed', output: result });
      emit(ctx.sessionId, { type: 'part-state', partId, state: 'completed', output: result });
      onChange?.(result);
      return result;
    } catch (err) {
      const failure: ToolResult = { error: (err as Error).message };
      updatePart(partId, { state: 'error', output: failure });
      emit(ctx.sessionId, { type: 'part-state', partId, state: 'error', output: failure });
      return failure;
    }
  }

  const tools: ToolSet = {
    read: tool({
      description: 'Read a text file with line numbers. Always read before editing. Binary files are rejected.',
      inputSchema: z.object({
        filePath: z.string().describe('Path relative to the workspace root'),
        offset: z.number().int().min(1).optional().describe('First line to read (1-based)'),
        limit: z.number().int().min(1).max(2000).optional().describe('Number of lines to read'),
      }),
      execute: async ({ filePath, offset, limit }, { toolCallId }) => {
        const effectiveLimit = limit ?? numberFrom(defaultsFor('read').limit) ?? 400;
        return run(toolCallId, 'read', { filePath, offset, limit: effectiveLimit }, () =>
          readFile(ctx.root, filePath, offset ?? 1, effectiveLimit));
      },
    }),

    write: tool({
      description: 'Create or fully overwrite a file. Use edit for surgical changes to existing files.',
      inputSchema: z.object({
        filePath: z.string(),
        content: z.string().describe('Full new file contents'),
      }),
      execute: async ({ filePath, content }, { toolCallId }) =>
        run(toolCallId, 'write', { filePath, content }, () => writeFile(ctx.root, filePath, content), (result) => {
          const r = result as { path: string; before: string | null; after: string };
          recordFileChange(ctx.sessionId, r.path, r.before, r.after, 'write');
          emit(ctx.sessionId, { type: 'file-changed', path: r.path });
        }),
    }),

    edit: tool({
      description: 'Replace an exact string in a file. oldString must match verbatim and be unique unless replaceAll is true.',
      inputSchema: z.object({
        filePath: z.string(),
        oldString: z.string(),
        newString: z.string(),
        replaceAll: z.boolean().optional(),
      }),
      execute: async (args, { toolCallId }) =>
        run(toolCallId, 'edit', args, () => editFile(ctx.root, args.filePath, args.oldString, args.newString, args.replaceAll), (result) => {
          const r = result as { path: string; before: string; after: string };
          recordFileChange(ctx.sessionId, r.path, r.before, r.after, 'edit');
          emit(ctx.sessionId, { type: 'file-changed', path: r.path });
        }),
    }),

    bash: tool({
      description: 'Run a non-interactive shell command in the workspace (builds, tests, git, package managers).',
      inputSchema: z.object({
        command: z.string(),
        workdir: z.string().optional().describe('Relative directory to run in'),
        timeoutMs: z.number().int().min(1000).max(600000).optional(),
      }),
      execute: async ({ command, workdir, timeoutMs }, { toolCallId }) => {
        const effectiveTimeout = timeoutMs ?? numberFrom(defaultsFor('bash').timeoutMs);
        // A shell can escape any in-process path check, so regular accounts do
        // not get one by default. They can still read/write/edit within their
        // own workspace. Admins (the owner) keep the full toolset.
        if (!ctx.allowShell) {
          return run(toolCallId, 'bash', { command, workdir }, () => ({
            error: 'Shell commands are disabled for this account. Use the read, write, edit, list, glob and grep tools instead.',
            denied: true,
          }));
        }
        return run(toolCallId, 'bash', { command, workdir, timeoutMs: effectiveTimeout }, () =>
          runShell(resolveSafe(ctx.root, workdir ?? '.'), command, { timeoutMs: effectiveTimeout, signal: ctx.signal }));
      },
    }),

    list: tool({
      description: 'List files/directories, optionally as a recursive tree.',
      inputSchema: z.object({
        path: z.string().optional(),
        depth: z.number().int().min(1).max(5).optional().describe('Tree depth (default 1 = flat listing)'),
      }),
      execute: async ({ path: rel, depth }, { toolCallId }) =>
        run(toolCallId, 'list', { path: rel, depth }, () => ({
          entries: depth && depth > 1 ? tree(ctx.root, rel ?? '.', depth) : listDir(ctx.root, rel ?? '.'),
        })),
    }),

    glob: tool({
      description: 'Find files by glob pattern, e.g. "src/**/*.ts". Respects .gitignore-style defaults.',
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        max: z.number().int().min(1).max(1000).optional(),
      }),
      execute: async ({ pattern, path: rel, max }, { toolCallId }) => {
        const effectiveMax = max ?? numberFrom(defaultsFor('glob').max);
        return run(toolCallId, 'glob', { pattern, path: rel }, () =>
          ({ matches: glob(ctx.root, pattern, { cwd: rel, max: effectiveMax }) }));
      },
    }),

    grep: tool({
      description: 'Search file contents with a regular expression and return matching lines with line numbers.',
      inputSchema: z.object({
        pattern: z.string(),
        path: z.string().optional(),
        include: z.string().optional().describe('Glob filter, e.g. "*.ts" or "*.{ts,vue}"'),
        caseSensitive: z.boolean().optional(),
        max: z.number().int().min(1).max(500).optional(),
      }),
      execute: async (args, { toolCallId }) => {
        const effectiveMax = args.max ?? numberFrom(defaultsFor('grep').max);
        const include = args.include ?? stringFrom(defaultsFor('grep').include);
        return run(toolCallId, 'grep', { ...args, include, max: effectiveMax }, () => ({
          matches: grep(ctx.root, args.pattern, {
            path: args.path, include, caseSensitive: args.caseSensitive, max: effectiveMax,
          }),
        }));
      },
    }),

    webfetch: tool({
      description: 'Fetch a public http(s) page and return its text content (scripts/styles stripped).',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }, { toolCallId }) =>
        run(toolCallId, 'webfetch', { url }, () => webfetch(url).then(content => ({ content }))),
    }),

    todo: tool({
      description: 'Replace the session todo list. Use for multi-step work to show progress.',
      inputSchema: z.object({
        todos: z.array(z.object({
          content: z.string(),
          status: z.enum(['pending', 'in_progress', 'completed', 'cancelled']),
          priority: z.enum(['low', 'medium', 'high']).optional(),
        })),
      }),
      execute: async ({ todos }, { toolCallId }) =>
        run(toolCallId, 'todo', { todos }, () => {
          const saved = setTodos(ctx.sessionId, todos.map(t => ({ ...t, priority: t.priority ?? 'medium' })));
          emit(ctx.sessionId, { type: 'todos', todos: saved });
          return { todos: saved };
        }),
    }),

    getTodos: tool({
      description: 'Read the current session todo list.',
      inputSchema: z.object({}),
      execute: async (_args, { toolCallId }) =>
        run(toolCallId, 'getTodos', {}, () => ({ todos: getTodos(ctx.sessionId) })),
    }),

    skills: tool({
      description: 'List the Agent Skills installed for this workspace, or read one skill\'s full instructions.',
      inputSchema: z.object({
        id: z.string().optional().describe('Skill id (<scope>:<slug>) to read in full'),
      }),
      execute: async ({ id }, { toolCallId }) =>
        run(toolCallId, 'skills', { id }, () => {
          const skills = listSkills(ctx.root);
          if (id) {
            const skill = skills.find(s => s.id === id);
            if (!skill) return { error: `Unknown skill: ${id}`, skills: skills.map(s => s.id) };
            return {
              id: skill.id, name: skill.name, description: skill.description, version: skill.version,
              enabled: skill.enabled, allowedTools: skill.allowedTools, toolDefaults: skill.toolDefaults,
              instructions: skill.instructions,
            };
          }
          return {
            skills: skills.map(s => ({
              id: s.id, name: s.name, description: s.description, enabled: s.enabled,
              scope: s.scope, allowedTools: s.allowedTools,
            })),
          };
        }),
    }),

    settings: tool({
      description: 'Read the current agent settings (active model info is in the system context).',
      inputSchema: z.object({}),
      execute: async (_args, { toolCallId }) =>
        run(toolCallId, 'settings', {}, () => getSettings(ctx.userId) as unknown as ToolResult),
    }),
  };

  // A skill can narrow the toolset (e.g. a review skill exposes only read-only tools).
  const allowed = ctx.allowedTools ?? [];
  if (allowed.length) {
    const keep = new Set([...allowed, 'skills', 'todo', 'getTodos', 'settings']);
    for (const name of Object.keys(tools)) {
      if (!keep.has(name)) delete (tools as Record<string, unknown>)[name];
    }
  }

  return tools;
}
