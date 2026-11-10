import { streamText, stepCountIs, type ModelMessage } from 'ai';
import type { AgentMode, AgentEvent, ChatRequest, Part, Usage } from '@codingagent/shared';
import {
  appendPart, appendText, createMessage, findPartByToolCall, getFallbackChain, getHistory,
  getModel, getSession, getSettings, logRequest, setHistory, touchSession, updatePart, updateSession,
} from '../db/repo';
import { resolveModel } from '../llm/client';
import type { Actor } from '../auth/service';
import { abortAllPermissions, emit } from './bus';
import { buildSystemPrompt, buildTitlePrompt } from './prompt';
import { createTools, type ToolContext } from './tools';
import { formatAttachmentBlock, resolveAttachments } from '../workspace/attachments';
import { gitBranch, runWorkspace } from '../workspace/registry';
import { activeSkills, allowedToolsFor, mergeToolDefaults } from '../skills/registry';

const running = new Map<string, AbortController>();
/** SSE keep-alive subscribers are registered by the HTTP layer; agent loops just emit. */

export function isRunning(sessionId: string): boolean { return running.has(sessionId); }

export function abortRun(sessionId: string): boolean {
  const controller = running.get(sessionId);
  if (!controller) return false;
  controller.abort();
  abortAllPermissions('Run aborted by user');
  return true;
}

function send(sessionId: string, event: AgentEvent): void { emit(sessionId, event); }

export interface RunInput {
  sessionId: string;
  request: ChatRequest;
  /** The account whose keys, workspace and settings this run may use. */
  actor: Actor;
  /** Allows the HTTP layer to hook a fresh SSE subscriber before the run starts. */
  onReady?: () => void | Promise<void>;
}

export async function runAgent(input: RunInput): Promise<void> {
  try {
    await runAgentInner(input);
  } catch (err) {
    // Errors raised before the stream starts still have to reach the UI and
    // release the per-session run lock.
    const { sessionId } = input;
    running.delete(sessionId);
    touchSession(sessionId, 'error');
    const message = (err as Error).message || String(err);
    emit(sessionId, { type: 'error', message });
    emit(sessionId, { type: 'done', reason: 'error' });
    console.error('[agent] run failed:', message);
  }
}

async function runAgentInner({ sessionId, request, actor, onReady }: RunInput): Promise<void> {
  const { userId } = actor;
  const session = getSession(sessionId, userId);
  if (!session) throw new Error(`Session ${sessionId} not found`);
  if (running.has(sessionId)) throw new Error('A response is already streaming for this session.');

  const settings = getSettings(userId);
  const platform = request.modelPlatform ?? session.modelPlatform ?? settings.defaultPlatform;
  const modelId = request.modelId ?? session.modelId ?? settings.defaultModelId;
  if (!platform || !modelId) {
    throw new Error('No model selected. Add your own API key in Settings > Providers & keys, then pick a model.');
  }
  const agent: AgentMode = request.agent ?? session.agent ?? settings.agent;
  // Every write in this run must land in THIS session's folder. Use the shared
  // resolver rather than re-deriving a root here: the old code fell back to
  // `activeRoot()` (the account-wide pointer) whenever the session's project
  // had no root, which silently redirected writes into another session's
  // directory. An unbound session now writes only to the account's home.
  const { root, project } = runWorkspace(sessionId, actor);
  const maxSteps = request.maxSteps ?? settings.maxSteps;

  const chosen = getModel(platform, modelId, userId);
  if (!chosen) throw new Error(`Model ${platform}/${modelId} is not in the catalog.`);
  if (!chosen.supportsTools) {
    throw new Error(`${chosen.displayName} is marked supports_tools=0 in the catalog and cannot run the agent loop. Pick a tool-capable model.`);
  }
  if (!chosen.hasKey) {
    throw new Error(
      `Your account has no API key for ${platform}. CodingAgent is BYOK — add your own key in Settings > Providers & keys to use this model.`,
    );
  }

  // Candidate chain: selected model first, then the reused fallback_config
  // ordering, filtered to providers this account actually owns a key for.
  const candidates = [
    chosen,
    ...getFallbackChain(userId, 5).filter(m => !(m.platform === platform && m.modelId === modelId)),
  ].slice(0, 4);

  const controller = new AbortController();
  running.set(sessionId, controller);
  touchSession(sessionId, 'running');
  send(sessionId, { type: 'session', session: getSession(sessionId, userId)! });

  // Persist the user turn: the visible text, plus exactly which files were
  // pinned to it (the content itself stays out of the DB, only a preview).
  const resolvedAttachments = resolveAttachments(root, request.attachments ?? [], actor);
  const attachmentBlock = formatAttachmentBlock(resolvedAttachments.attachments, resolvedAttachments.errors);

  const userParts: Array<Partial<Part>> = [];
  if (request.text.trim()) userParts.push({ type: 'text', state: 'completed', text: request.text });
  if (resolvedAttachments.attachments.length || resolvedAttachments.errors.length) {
    userParts.push({
      type: 'attachment',
      state: 'completed',
      text: '',
      input: {
        attachments: resolvedAttachments.attachments.map(a => ({
          path: a.path,
          name: a.name,
          size: a.size,
          truncated: a.truncated,
          external: a.external,
          kind: a.kind,
          tokens: a.tokens,
          preview: a.content.slice(0, 240),
        })),
        errors: resolvedAttachments.errors,
      },
    });
  }
  const userMessage = createMessage(sessionId, 'user', userParts);
  send(sessionId, { type: 'message', message: userMessage });

  if (session.title === 'New session' || !session.title) {
    // A file-only turn still deserves a readable title.
    const titleSource = request.text.trim() || resolvedAttachments.attachments[0]?.name || 'New session';
    const titled = updateSession(userId, sessionId, { title: buildTitlePrompt(titleSource) });
    if (titled) send(sessionId, { type: 'session', session: titled });
  }

  const assistantMessage = createMessage(sessionId, 'assistant');
  send(sessionId, { type: 'message', message: assistantMessage });

  const history = getHistory(sessionId) as ModelMessage[];
  const turnText = [request.text.trim(), attachmentBlock].filter(Boolean).join('\n\n');
  history.push({ role: 'user', content: turnText });

  // Installed Agent Skills inject standing guidance and per-tool defaults.
  const skills = activeSkills(root);
  const toolCtx: ToolContext = {
    sessionId,
    userId,
    allowShell: actor.allowShell,
    assistantMessageId: assistantMessage.id,
    root,
    agent,
    permissionMode: settings.permissionMode,
    signal: controller.signal,
    toolDefaults: mergeToolDefaults(skills),
    allowedTools: allowedToolsFor(skills),
  };
  const tools = createTools(toolCtx);
  const branch = gitBranch(root);
  const system = buildSystemPrompt(agent, {
    suffix: settings.systemPromptSuffix,
    skills,
    context: [
      `Model: ${chosen.displayName} (${chosen.platform}/${chosen.modelId})`,
      `Workspace: ${project?.name ?? 'account home'} — ${root}${branch ? ` (git: ${branch})` : ''}`,
      project ? '' : 'No project folder is bound to this session. Files are confined to the account home; ask the user to pick a folder before creating files.',
      `Agent mode: ${agent}`,
      resolvedAttachments.attachments.length
        ? `Attached this turn: ${resolvedAttachments.attachments.map(a => a.path).join(', ')}`
        : '',
      skills.length ? `Active skills: ${skills.map(s => s.name).join(', ')}` : '',
    ],
  });

  await onReady?.();

  let lastError = '';
  let succeeded = false;

  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    let emittedOutput = false;
    let accumulatedText = '';
    let activeTextPartId: string | null = null;
    let activeReasonPartId: string | null = null;
    const startedAt = Date.now();

    const ensureTextPart = (field: 'text' | 'reasoning'): string => {
      if (field === 'text' && activeTextPartId) return activeTextPartId;
      if (field === 'reasoning' && activeReasonPartId) return activeReasonPartId;
      const part = appendPart(assistantMessage.id, sessionId, {
        type: field, state: 'running', text: '',
      });
      if (field === 'text') activeTextPartId = part.id; else activeReasonPartId = part.id;
      send(sessionId, { type: 'part', part });
      return part.id;
    };

    try {
      const resolved = resolveModel(candidate.platform, candidate.modelId, userId);
      const result = streamText({
        model: resolved.model,
        system,
        messages: history,
        tools,
        stopWhen: stepCountIs(maxSteps),
        abortSignal: controller.signal,
      });

      for await (const raw of result.fullStream) {
        const part = raw as any;
        switch (part.type) {
          case 'start-step':
            activeTextPartId = null;
            activeReasonPartId = null;
            break;

          case 'text-delta': {
            if (!part.text) break;
            const id = ensureTextPart('text');
            appendText(id, part.text);
            accumulatedText += part.text;
            send(sessionId, { type: 'part-delta', partId: id, field: 'text', delta: part.text });
            emittedOutput = true;
            break;
          }

          case 'reasoning-delta': {
            if (!part.text) break;
            const id = ensureTextPart('reasoning');
            appendText(id, part.text);
            send(sessionId, { type: 'part-delta', partId: id, field: 'reasoning', delta: part.text });
            emittedOutput = true;
            break;
          }

          case 'tool-call': {
            emittedOutput = true;
            let toolPart = findPartByToolCall(part.toolCallId);
            if (!toolPart) {
              toolPart = appendPart(assistantMessage.id, sessionId, {
                type: 'tool', toolCallId: part.toolCallId, toolName: part.toolName,
                state: 'pending', input: part.input,
              });
              send(sessionId, { type: 'part', part: toolPart });
            }
            break;
          }

          case 'tool-error': {
            const toolPart = findPartByToolCall(part.toolCallId);
            if (toolPart && toolPart.state !== 'completed') {
              const out = { error: String(part.error?.message ?? part.error ?? 'Tool failed') };
              const updated = updatePart(toolPart.id, { state: 'error', output: out });
              send(sessionId, { type: 'part-state', partId: toolPart.id, state: 'error', output: out });
              void updated;
            }
            break;
          }

          case 'finish-step': {
            if (activeTextPartId) {
              const p = updatePart(activeTextPartId, { state: 'completed' });
              send(sessionId, { type: 'part-state', partId: p.id, state: 'completed' });
            }
            if (activeReasonPartId) {
              const p = updatePart(activeReasonPartId, { state: 'completed' });
              send(sessionId, { type: 'part-state', partId: p.id, state: 'completed' });
            }
            break;
          }

          case 'finish': {
            const usage = part.totalUsage ?? part.usage;
            if (usage) {
              const u: Usage = {
                inputTokens: usage.inputTokens ?? 0,
                outputTokens: usage.outputTokens ?? 0,
                totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
              };
              send(sessionId, { type: 'usage', usage: u });
              logRequest({
                platform: candidate.platform, modelId: candidate.modelId, status: 'success', sessionId,
                inputTokens: u.inputTokens, outputTokens: u.outputTokens, latencyMs: Date.now() - startedAt, agent, userId,
              });
            }
            break;
          }

          case 'error': {
            lastError = String(part.error?.message ?? part.error ?? 'Unknown model error');
            break;
          }
          default:
            break;
        }
      }

      if (lastError && !emittedOutput) throw new Error(lastError);

      // Keep exact assistant + tool messages so the next turn has full tool context.
      try {
        const response = await result.response;
        const responseMessages = (response as any)?.messages as ModelMessage[] | undefined;
        if (responseMessages?.length) history.push(...responseMessages);
        else history.push({ role: 'assistant', content: accumulatedText });
      } catch {
        history.push({ role: 'assistant', content: accumulatedText });
      }
      setHistory(sessionId, history);

      if (index > 0) {
        send(sessionId, {
          type: 'part',
          part: appendPart(assistantMessage.id, sessionId, {
            type: 'text', state: 'completed',
            text: `\n\n_Automatically fell back to ${candidate.displayName} (${candidate.platform})._`,
          }),
        });
      }
      succeeded = true;
      break;
    } catch (err) {
      lastError = (err as Error).message || String(err);
      if (controller.signal.aborted) {
        succeeded = true; // user-initiated stop is not an error
        break;
      }
      logRequest({
        platform: candidate.platform, modelId: candidate.modelId, status: 'error', sessionId,
        latencyMs: Date.now() - startedAt, error: lastError.slice(0, 500), agent, userId,
      });
      // Only retry when nothing was streamed yet, so we never duplicate output.
      if (emittedOutput || index === candidates.length - 1) break;
      console.warn(`[agent] ${candidate.platform}/${candidate.modelId} failed (${lastError}); trying fallback.`);
      continue;
    }
  }

  running.delete(sessionId);
  const finalStatus = succeeded ? 'idle' : 'error';
  touchSession(sessionId, finalStatus);
  const finalSession = getSession(sessionId, userId)!;
  send(sessionId, { type: 'session', session: finalSession });

  if (!succeeded && lastError) {
    const part = appendPart(assistantMessage.id, sessionId, {
      type: 'error', state: 'error', text: lastError,
    });
    send(sessionId, { type: 'part', part });
    send(sessionId, { type: 'error', message: lastError });
  }
  send(sessionId, { type: 'done', reason: controller.signal.aborted ? 'aborted' : succeeded ? 'stop' : 'error' });
}

