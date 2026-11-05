import fs from 'node:fs';
import path from 'node:path';
import type { Attachment, AttachmentInput, ResolveAttachmentsResult } from '@codingagent/shared';
import { expandHome, isBinary, isInside, isDirectory, resolveSafe } from './paths';

/** Per-file cap. Large enough for a big source file, small enough to stay in context. */
const MAX_ATTACHMENT_BYTES = 256 * 1024;
/** Whole-turn cap across every attachment (~50k tokens). */
const MAX_TOTAL_CHARS = 200_000;

function kindOf(name: string): string {
  const ext = path.extname(name).replace(/^\./, '').toLowerCase();
  return ext || 'file';
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Turn one attachment request into the text the model actually receives.
 *
 * Two sources are supported on purpose:
 *  - `path`: the server reads the file itself (workspace-relative or absolute).
 *  - `content`: the browser read a device file but cannot expose its real
 *    path, so the bytes arrive inline and are trusted as an explicit user pick.
 */
export function resolveAttachment(root: string, input: AttachmentInput): Attachment {
  const requested = (input.path ?? '').trim();
  if (!requested) throw new Error('Empty attachment path.');

  if (typeof input.content === 'string' && input.content.length) {
    const content = input.content.length > MAX_ATTACHMENT_BYTES
      ? input.content.slice(0, MAX_ATTACHMENT_BYTES)
      : input.content;
    const name = input.name || path.basename(requested) || requested;
    return {
      path: requested,
      name,
      size: input.content.length,
      content,
      truncated: content.length < input.content.length,
      external: input.external ?? true,
      kind: kindOf(name),
      tokens: Math.ceil(content.length / 4),
    };
  }

  const expanded = expandHome(requested);
  const absolute = path.isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded);
  const external = absolute ? !isInside(root, expanded) : false;

  // Workspace-relative paths go through the sandbox (symlinks included);
  // absolute paths were chosen explicitly by the user in the picker.
  const abs = absolute ? path.resolve(expanded) : resolveSafe(root, expanded);
  if (!fs.existsSync(abs)) throw new Error(`File not found: ${requested}`);
  if (isDirectory(abs)) throw new Error(`That is a folder, not a file: ${requested}`);

  const stat = fs.statSync(abs);
  const buffer = fs.readFileSync(abs);
  if (isBinary(buffer)) throw new Error(`Binary file cannot be attached: ${requested}`);

  const raw = buffer.toString('utf8');
  const content = raw.length > MAX_ATTACHMENT_BYTES ? raw.slice(0, MAX_ATTACHMENT_BYTES) : raw;
  const name = input.name || path.basename(abs);

  return {
    path: external ? abs : path.relative(root, abs).replace(/\\/g, '/'),
    name,
    size: stat.size,
    content,
    truncated: content.length < raw.length,
    external,
    kind: kindOf(name),
    tokens: Math.ceil(content.length / 4),
  };
}

export function resolveAttachments(root: string, inputs: AttachmentInput[] = []): ResolveAttachmentsResult {
  const attachments: Attachment[] = [];
  const errors: Array<{ path: string; error: string }> = [];
  let budget = MAX_TOTAL_CHARS;

  for (const input of inputs) {
    try {
      const attachment = resolveAttachment(root, input);
      if (budget <= 0) {
        errors.push({ path: input.path, error: 'Skipped: the attachment budget for this turn is exhausted.' });
        continue;
      }
      if (attachment.content.length > budget) {
        attachment.content = attachment.content.slice(0, budget);
        attachment.truncated = true;
        attachment.tokens = Math.ceil(attachment.content.length / 4);
        errors.push({ path: input.path, error: 'Truncated: the attachment budget for this turn is exhausted.' });
      }
      budget -= attachment.content.length;
      attachments.push(attachment);
    } catch (err) {
      errors.push({ path: input.path, error: (err as Error).message });
    }
  }
  return { attachments, errors };
}

/**
 * Render attachments as a delimited block appended to the user turn. The
 * delimiters are line-based so they survive file contents that contain
 * backticks or markdown fences.
 */
export function formatAttachmentBlock(attachments: Attachment[], errors: Array<{ path: string; error: string }> = []): string {
  if (!attachments.length && !errors.length) return '';
  const parts: string[] = [
    '<attached-files>',
    'The user explicitly attached these files to this message. Read them as the primary context for this turn instead of scanning the whole workspace.',
    '',
  ];

  for (const attachment of attachments) {
    const lines = attachment.content ? attachment.content.split(/\r?\n/).length : 0;
    const flags = [
      attachment.external ? 'outside the workspace, attached explicitly' : 'workspace file',
      `${lines} lines`,
      humanSize(attachment.size),
      attachment.truncated ? 'TRUNCATED' : '',
    ].filter(Boolean).join(', ');
    parts.push(`=== FILE: ${attachment.path} (${flags}) ===`);
    parts.push(attachment.content);
    parts.push(`=== END FILE: ${attachment.path} ===`, '');
  }

  for (const failure of errors) {
    parts.push(`=== FILE: ${failure.path} (NOT ATTACHED: ${failure.error}) ===`, '');
  }

  parts.push('</attached-files>');
  return parts.join('\n');
}

export { MAX_ATTACHMENT_BYTES, MAX_TOTAL_CHARS, humanSize };
