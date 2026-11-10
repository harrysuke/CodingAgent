<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Files, GitCompareArrows, ListTodo, X, Circle, CircleCheck, Loader2 } from 'lucide-vue-next';
import { diffLines } from 'diff';
import { useAppStore } from '../stores/app';
import FileTree from './FileTree.vue';

const store = useAppStore();
const emit = defineEmits<{ (e: 'close'): void; (e: 'open-file', path: string): void }>();
const tab = computed({
  get: () => store.rightPanel ?? 'files',
  set: (value: 'files' | 'changes' | 'todos') => { store.rightPanel = value; },
});
const selectedChange = ref<string | null>(null);

const tabs = [
  { value: 'files', label: 'Files', icon: Files },
  { value: 'changes', label: 'Changes', icon: GitCompareArrows },
  { value: 'todos', label: 'Plan', icon: ListTodo },
] as const;

watch(tab, value => {
  if (value === 'changes') void store.loadChanges();
});

function patchFor(before: string | null, after: string): string {
  const chunks = diffLines(before ?? '', after);
  return chunks.map(c => c.value.split(/\r?\n/).filter(Boolean).map(line => `${c.added ? '+' : c.removed ? '-' : ' '}${line}`).join('\n')).join('\n');
}

const selected = computed(() => store.fileChanges.find(c => c.id === selectedChange.value) ?? null);

function statusIcon(status: string) {
  if (status === 'completed') return CircleCheck;
  if (status === 'in_progress') return Loader2;
  if (status === 'cancelled') return X;
  return Circle;
}
</script>

<template>
  <aside class="hidden xl:flex w-[300px] shrink-0 flex-col border-l hairline bg-[var(--surface-2)] min-h-0">
    <!-- Tabs -->
    <div class="flex items-center border-b hairline h-11 shrink-0 px-1">
      <button v-for="item in tabs" :key="item.value"
        class="flex-1 flex items-center justify-center gap-1.5 h-full text-[11.5px] font-medium border-b-2 transition-colors"
        :class="tab === item.value ? 'border-[var(--accent)] text-[var(--accent-text)]' : 'border-transparent text-[var(--muted)] hover:text-[var(--text)]'"
        @click="tab = item.value">
        <component :is="item.icon" :size="13" /> {{ item.label }}
        <span v-if="item.value === 'changes' && store.fileChanges.length" class="text-[10px] rounded-full bg-[var(--surface-3)] px-1.5">{{ store.fileChanges.length }}</span>
      </button>
      <button class="p-1.5 mr-1 rounded hover-soft text-[var(--muted)]" @click="emit('close')"><X :size="14" /></button>
    </div>

    <div class="flex-1 min-h-0 overflow-hidden">
      <FileTree v-if="tab === 'files'" @open="path => emit('open-file', path)" />

      <div v-else-if="tab === 'changes'" class="h-full overflow-y-auto p-2.5">
        <div v-if="!store.fileChanges.length" class="text-[11.5px] text-center text-[var(--faint)] py-10 px-4">
          No file changes yet.<br />Edits made by the agent appear here with diffs.
        </div>
        <div v-else class="space-y-1.5">
          <button v-for="change in store.fileChanges" :key="change.id"
            class="w-full text-left rounded-lg border hairline bg-[var(--surface)] px-2.5 py-2 hover-soft"
            @click="selectedChange = selectedChange === change.id ? null : change.id">
            <div class="flex items-center gap-2">
              <span class="text-[11px] font-mono truncate flex-1">{{ change.path }}</span>
              <span class="text-[9px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-text)] shrink-0">{{ change.toolName }}</span>
            </div>
            <div class="text-[10px] text-[var(--faint)] mt-0.5">{{ new Date(change.createdAt + 'Z').toLocaleTimeString() }}</div>
          </button>
          <div v-if="selected" class="mt-2 rounded-lg border hairline overflow-hidden">
            <div class="max-h-96 overflow-auto bg-[var(--code-bg)] py-1">
              <div v-for="(line, i) in patchFor(selected.before, selected.after).split('\n')" :key="i"
                class="diff-line" :class="{
                  'diff-add': line.startsWith('+'),
                  'diff-del': line.startsWith('-'),
                }">{{ line }}</div>
            </div>
          </div>
        </div>
      </div>

      <div v-else class="h-full overflow-y-auto p-3">
        <div v-if="!store.todos.length" class="text-[11.5px] text-center text-[var(--faint)] py-10 px-4">
          No plan yet. The agent will create one for multi-step work.
        </div>
        <div v-for="todo in store.todos" :key="todo.id" class="flex items-start gap-2 py-1.5">
          <component :is="statusIcon(todo.status)" :size="14" class="mt-0.5 shrink-0"
            :class="{ 'text-[var(--green)]': todo.status === 'completed', 'text-[var(--blue)] animate-spin': todo.status === 'in_progress', 'text-[var(--faint)]': todo.status === 'pending' }" />
          <span class="text-[11.5px]" :class="{ 'line-through text-[var(--faint)]': todo.status === 'completed' || todo.status === 'cancelled' }">{{ todo.content }}</span>
        </div>
      </div>
    </div>

    <div class="border-t hairline px-3 py-2 text-[10px] text-[var(--muted)] truncate shrink-0"
      :title="store.activeWorkspace?.root ?? store.connection.health?.workspaceRoot">
      {{ store.activeWorkspace?.root ?? store.connection.health?.workspaceRoot ?? 'workspace' }}
    </div>
  </aside>
</template>
