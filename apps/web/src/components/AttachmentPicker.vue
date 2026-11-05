<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import {
  X, Search, FileCode2, FileText, FileJson, FilePlus2, FolderOpen, Upload, Loader2,
  AlertTriangle, Check, Paperclip, HardDriveDownload,
} from 'lucide-vue-next';
import type { FileNode } from '@codingagent/shared';
import { useAppStore } from '../stores/app';

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const store = useAppStore();

const tab = ref<'workspace' | 'device'>('workspace');
const query = ref('');
const loading = ref(false);
const failure = ref('');
const fileInput = ref<HTMLInputElement | null>(null);

interface Row { node: FileNode; depth: number }

function flatten(nodes: FileNode[], depth: number, out: Row[]): void {
  for (const node of nodes) {
    if (node.type === 'file') out.push({ node, depth });
    if (node.children?.length) flatten(node.children, depth + 1, out);
  }
}

const files = computed<Row[]>(() => {
  const out: Row[] = [];
  flatten(store.fileTree, 0, out);
  const q = query.value.trim().toLowerCase();
  const filtered = q ? out.filter(row => row.node.path.toLowerCase().includes(q)) : out;
  return filtered.slice(0, 400);
});

const attachedCount = computed(() => store.attachments.length);

function sizeLabel(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function kindOf(name: string): string {
  const ext = name.split('.').pop() ?? '';
  return ext && ext !== name ? ext.toLowerCase() : 'file';
}

function iconFor(name: string) {
  const kind = kindOf(name);
  if (['ts', 'tsx', 'js', 'jsx', 'vue', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(kind)) return FileCode2;
  if (['json', 'yaml', 'yml', 'toml'].includes(kind)) return FileJson;
  if (['md', 'txt', 'log'].includes(kind)) return FileText;
  return FilePlus2;
}

function isAttached(path: string): boolean {
  return store.attachments.some(a => a.path === path && !a.external);
}

function attachWorkspaceFile(node: FileNode) {
  store.addAttachment({
    path: node.path,
    name: node.name,
    external: false,
    size: node.size,
    kind: kindOf(node.name),
    tokens: node.size ? Math.ceil(node.size / 4) : undefined,
  });
}

async function onDeviceFiles(event: Event) {
  const input = event.target as HTMLInputElement;
  const picked = Array.from(input.files ?? []);
  failure.value = '';
  const problem = await store.attachDeviceFiles(picked);
  if (problem) failure.value = problem;
  input.value = '';
}

function pickDeviceFiles() {
  fileInput.value?.click();
}

async function refreshTree() {
  loading.value = true;
  try { await store.loadTree(); } finally { loading.value = false; }
}

watch(() => props.open, value => {
  if (!value) return;
  query.value = '';
  failure.value = '';
  tab.value = 'workspace';
  void refreshTree();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6" @click.self="emit('close')">
      <div class="w-full max-w-2xl max-h-[85vh] surface rounded-2xl shadow-[var(--shadow)] flex flex-col overflow-hidden fade-up">
        <!-- Header -->
        <div class="flex items-center gap-2.5 px-4 py-3 border-b hairline shrink-0">
          <div class="w-8 h-8 rounded-lg bg-[var(--accent-soft)] text-[var(--accent-text)] grid place-items-center"><Paperclip :size="16" /></div>
          <div class="min-w-0 flex-1">
            <h2 class="text-[13.5px] font-semibold leading-tight">Attach context</h2>
            <p class="text-[10.5px] text-[var(--muted)] leading-tight">The agent reads exactly these files for this message</p>
          </div>
          <button class="p-1.5 rounded-lg hover-soft text-[var(--muted)]" @click="emit('close')"><X :size="16" /></button>
        </div>

        <!-- Tabs -->
        <div class="flex items-center gap-1 px-3 pt-2.5 shrink-0">
          <button class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium"
            :class="tab === 'workspace' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--muted)] hover-soft'"
            @click="tab = 'workspace'">
            <FolderOpen :size="13" /> Workspace files
          </button>
          <button class="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium"
            :class="tab === 'device' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--muted)] hover-soft'"
            @click="tab = 'device'">
            <HardDriveDownload :size="13" /> This device
          </button>
        </div>

        <!-- Workspace tab -->
        <template v-if="tab === 'workspace'">
          <div class="px-3 pt-2.5 shrink-0">
            <div class="relative">
              <Search :size="13" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
              <input v-model="query" placeholder="Filter files in this workspace…" spellcheck="false"
                class="w-full bg-[var(--surface-3)] rounded-lg pl-8 pr-2 py-1.5 text-[11.5px] outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            </div>
          </div>
          <div class="flex-1 min-h-[220px] overflow-y-auto px-2 py-2">
            <div v-if="loading" class="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--muted)]">
              <Loader2 :size="14" class="animate-spin" /> Loading file tree…
            </div>
            <div v-else-if="!files.length" class="py-10 text-center text-[11.5px] text-[var(--faint)]">
              No matching files. Open a workspace first, or use “This device”.
            </div>
            <button v-for="row in files" :key="row.node.path"
              class="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover-soft"
              :class="{ 'bg-[var(--accent-soft)]': isAttached(row.node.path) }"
              @click="attachWorkspaceFile(row.node)">
              <component :is="iconFor(row.node.name)" :size="13" class="shrink-0 text-[var(--muted)]" />
              <span class="font-mono text-[11px] truncate flex-1">{{ row.node.path }}</span>
              <span class="text-[9.5px] text-[var(--faint)] shrink-0">{{ sizeLabel(row.node.size) }}</span>
              <Check v-if="isAttached(row.node.path)" :size="12" class="text-[var(--green)] shrink-0" />
            </button>
          </div>
        </template>

        <!-- Device tab -->
        <template v-else>
          <div class="flex-1 min-h-[220px] px-4 py-4">
            <button class="w-full rounded-xl border border-dashed hairline bg-[var(--surface-2)] py-8 flex flex-col items-center gap-2 hover:border-[var(--accent)] transition-colors"
              @click="pickDeviceFiles">
              <Upload :size="22" class="text-[var(--accent-text)]" />
              <span class="text-[12px] font-medium">Choose files from this device</span>
              <span class="text-[10.5px] text-[var(--muted)] text-center max-w-xs leading-snug">
                Text files only, up to 256 KB each. Contents are inlined into the prompt for this turn.
              </span>
            </button>
            <input ref="fileInput" type="file" multiple class="hidden" @change="onDeviceFiles" />

            <div v-if="store.attachments.filter(a => a.external).length" class="mt-3 space-y-1">
              <div class="text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]">Picked from device</div>
              <div v-for="draft in store.attachments.filter(a => a.external)" :key="draft.key"
                class="flex items-center gap-2 rounded-lg border hairline bg-[var(--surface)] px-2 py-1.5">
                <component :is="iconFor(draft.name)" :size="12" class="text-[var(--muted)] shrink-0" />
                <span class="text-[11px] truncate flex-1">{{ draft.name }}</span>
                <span class="text-[9.5px] text-[var(--faint)] shrink-0">{{ sizeLabel(draft.size) }}</span>
                <button class="p-0.5 rounded hover-soft text-[var(--red)]" @click="store.removeAttachment(draft.key)"><X :size="12" /></button>
              </div>
            </div>
          </div>
        </template>

        <!-- Error -->
        <div v-if="failure" class="mx-3 mb-2 flex items-start gap-2 rounded-lg border border-[var(--amber)]/30 bg-[var(--amber-soft)] px-2.5 py-1.5 text-[11px] text-[var(--amber)] shrink-0">
          <AlertTriangle :size="12" class="shrink-0 mt-0.5" />{{ failure }}
        </div>

        <!-- Footer -->
        <div class="flex items-center gap-2 px-3 py-3 border-t hairline shrink-0">
          <span class="flex-1 text-[10.5px] text-[var(--muted)]">
            {{ attachedCount }} file{{ attachedCount === 1 ? '' : 's' }} attached to the next message
          </span>
          <button class="rounded-lg bg-[var(--accent)] text-white px-3 py-1.5 text-[11.5px] font-medium hover:bg-[var(--accent-hover)]" @click="emit('close')">
            Done
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
