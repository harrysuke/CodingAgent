<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ChevronRight, Check, X, Loader2, FileText, Pencil, Terminal, Search, FolderOpen,
  Globe, ListChecks, AlertTriangle, FilePlus2,
} from 'lucide-vue-next';
import type { Part } from '@codingagent/shared';
import DiffView from './DiffView.vue';

const props = defineProps<{ part: Part }>();
const open = ref(false);

const ICONS: Record<string, unknown> = {
  read: FileText, write: FilePlus2, edit: Pencil, bash: Terminal, grep: Search,
  glob: Search, list: FolderOpen, webfetch: Globe, todo: ListChecks,
  getTodos: ListChecks, settings: ListChecks,
};
const icon = computed(() => ICONS[props.part.toolName ?? ''] ?? Terminal);

const label = computed(() => {
  const input = (props.part.input ?? {}) as Record<string, unknown>;
  const name = props.part.toolName ?? 'tool';
  if (name === 'bash') return `$ ${String(input.command ?? '').slice(0, 120)}`;
  if (name === 'read' || name === 'write' || name === 'edit') return String(input.filePath ?? name);
  if (name === 'grep') return `/${String(input.pattern ?? '')}/`;
  if (name === 'glob') return String(input.pattern ?? '');
  if (name === 'list') return String(input.path || '.');
  if (name === 'webfetch') return String(input.url ?? '');
  if (name === 'todo') return 'Update plan';
  return name;
});

const output = computed<Record<string, unknown>>(() => {
  const value = props.part.output;
  return value && typeof value === 'object' ? value as Record<string, unknown> : { result: value };
});

const patch = computed(() => typeof output.value.patch === 'string' ? output.value.patch : '');
const errorText = computed(() => typeof output.value.error === 'string' ? output.value.error : '');
const isDone = computed(() => ['completed', 'error', 'denied'].includes(props.part.state ?? ''));

const summary = computed(() => {
  if (errorText.value) return errorText.value.slice(0, 120);
  const o = output.value;
  if (Array.isArray(o.matches)) return `${o.matches.length} matches`;
  if (Array.isArray(o.entries)) return `${o.entries.length} entries`;
  if (Array.isArray(o.todos)) return `${o.todos.length} items`;
  if (typeof o.content === 'string') return `${(o.content as string).split('\n').length} lines`;
  if (typeof o.patch === 'string') return 'file updated';
  if (typeof o.stdout === 'string') return (o.stdout as string).trim() ? 'command finished' : 'no output';
  return '';
});

const stateColor = computed(() => ({
  pending: 'text-[var(--amber)] bg-[var(--amber-soft)]',
  running: 'text-[var(--blue)] bg-[var(--blue-soft)]',
  completed: 'text-[var(--green)] bg-[var(--green-soft)]',
  error: 'text-[var(--red)] bg-[var(--red-soft)]',
  denied: 'text-[var(--red)] bg-[var(--red-soft)]',
} as Record<string, string>)[props.part.state ?? 'pending'] ?? 'text-[var(--muted)] bg-[var(--surface-3)]');

function pretty(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}
</script>

<template>
  <div class="my-2 rounded-xl border hairline bg-[var(--surface-2)] overflow-hidden fade-up">
    <button
      class="w-full flex items-center gap-2.5 px-3 py-2 text-left hover-soft focus-ring"
      @click="open = !open"
    >
      <ChevronRight :size="14" class="shrink-0 text-[var(--faint)] transition-transform" :class="{ 'rotate-90': open }" />
      <component :is="icon" :size="14" class="shrink-0 text-[var(--accent-text)]" />
      <span class="text-[12px] font-semibold text-[var(--text)]">{{ part.toolName }}</span>
      <span class="text-[12px] font-mono text-[var(--muted)] truncate min-w-0 flex-1">{{ label }}</span>
      <Loader2 v-if="part.state === 'running' || part.state === 'pending'" :size="13" class="animate-spin text-[var(--blue)] shrink-0" />
      <span v-else class="text-[10px] px-1.5 py-0.5 rounded-md font-medium shrink-0" :class="stateColor">
        {{ part.state }}
      </span>
    </button>

    <div v-if="!isDone && !open" class="px-3 pb-2 pl-9 text-[11px] text-[var(--muted)]">
      <span v-if="part.state === 'pending'">Waiting for approval…</span>
      <span v-else>Running…</span>
    </div>
    <div v-else-if="isDone && !open && summary" class="px-3 pb-2 pl-9 text-[11px] truncate"
      :class="errorText ? 'text-[var(--red)]' : 'text-[var(--muted)]'">
      {{ summary }}
    </div>

    <div v-if="open" class="border-t hairline px-3 py-2.5 space-y-2.5 text-[12px]">
      <div v-if="part.input && Object.keys(part.input as object).length">
        <div class="text-[10px] uppercase tracking-wide text-[var(--faint)] font-semibold mb-1">Arguments</div>
        <pre class="whitespace-pre-wrap break-words font-mono text-[11px] bg-[var(--code-bg)] border hairline rounded-lg p-2 max-h-52 overflow-auto">{{ pretty(part.input) }}</pre>
      </div>

      <template v-if="patch">
        <div class="text-[10px] uppercase tracking-wide text-[var(--faint)] font-semibold mb-1">Changes</div>
        <DiffView :patch="patch" />
      </template>

      <div v-if="errorText" class="flex items-start gap-2 rounded-lg px-2.5 py-2 text-[var(--red)] bg-[var(--red-soft)]">
        <AlertTriangle :size="14" class="shrink-0 mt-0.5" /><span>{{ errorText }}</span>
      </div>

      <div v-else-if="output.stdout !== undefined || output.stderr !== undefined">
        <div class="text-[10px] uppercase tracking-wide text-[var(--faint)] font-semibold mb-1">
          Output <span v-if="output.exitCode !== undefined" class="normal-case">(exit {{ output.exitCode }})</span>
        </div>
        <pre v-if="output.stdout" class="whitespace-pre-wrap break-words font-mono text-[11px] bg-[var(--code-bg)] border hairline rounded-lg p-2 max-h-64 overflow-auto">{{ pretty(output.stdout) }}</pre>
        <pre v-if="output.stderr" class="whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--red)] bg-[var(--red-soft)] rounded-lg p-2 mt-1 max-h-40 overflow-auto">{{ pretty(output.stderr) }}</pre>
      </div>

      <div v-else-if="!patch && part.state === 'completed'">
        <div class="text-[10px] uppercase tracking-wide text-[var(--faint)] font-semibold mb-1">Result</div>
        <pre class="whitespace-pre-wrap break-words font-mono text-[11px] bg-[var(--code-bg)] border hairline rounded-lg p-2 max-h-64 overflow-auto">{{ pretty(output) }}</pre>
      </div>
    </div>
  </div>
</template>
