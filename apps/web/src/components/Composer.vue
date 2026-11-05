<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  ArrowUp, Square, ChevronDown, Cpu, ShieldCheck, Wrench, ClipboardList, Sparkles, Paperclip,
  X, FileCode2, FileText, FileJson, FilePlus2, Loader2, FolderOpen, GitBranch,
} from 'lucide-vue-next';
import type { ModelInfo } from '@codingagent/shared';
import { useAppStore } from '../stores/app';
import AttachmentPicker from './AttachmentPicker.vue';
import WorkspaceModal from './WorkspaceModal.vue';

const store = useAppStore();
const text = ref('');
const textarea = ref<HTMLTextAreaElement | null>(null);
const modelOpen = ref(false);
const agentOpen = ref(false);
const modelFilter = ref('');
const pickerOpen = ref(false);
const workspaceOpen = ref(false);
const dragging = ref(false);
const attachError = ref('');

const groupedModels = computed(() => {
  const q = modelFilter.value.trim().toLowerCase();
  const groups = new Map<string, ModelInfo[]>();
  for (const model of store.usableModels) {
    if (q && !`${model.displayName} ${model.platform} ${model.modelId}`.toLowerCase().includes(q)) continue;
    const list = groups.get(model.platform) ?? [];
    list.push(model);
    groups.set(model.platform, list);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
});

const agentModes = [
  { value: 'build', label: 'Build', hint: 'Read + write files and run commands', icon: Wrench },
  { value: 'plan', label: 'Plan', hint: 'Read-only implementation plan', icon: ClipboardList },
  { value: 'general', label: 'General', hint: 'Research and explanations', icon: Sparkles },
] as const;

const currentAgent = computed(() => agentModes.find(a => a.value === (store.currentSession?.agent ?? store.settings.agent)) ?? agentModes[0]);

const totalTokens = computed(() => store.attachments.reduce((sum, a) => sum + (a.tokens ?? 0), 0));

function sizeLabel(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(name: string) {
  const kind = store.kindOfName(name);
  if (['ts', 'tsx', 'js', 'jsx', 'vue', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(kind)) return FileCode2;
  if (['json', 'yaml', 'yml', 'toml'].includes(kind)) return FileJson;
  if (['md', 'txt', 'log'].includes(kind)) return FileText;
  return FilePlus2;
}

function resize() {
  const el = textarea.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 220)}px`;
}
watch(text, () => void nextTick(resize));

function submit() {
  const value = text.value.trim();
  if (store.running) return;
  if (!value && !store.attachments.length) return;
  text.value = '';
  void nextTick(resize);
  void store.send(value);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}

function chooseModel(platform: string, modelId: string) {
  modelOpen.value = false;
  void store.setModel(platform, modelId);
}
function chooseAgent(value: 'build' | 'plan' | 'general') {
  agentOpen.value = false;
  void store.setAgent(value);
}

async function onDrop(event: DragEvent) {
  dragging.value = false;
  const files = Array.from(event.dataTransfer?.files ?? []);
  if (!files.length) return;
  attachError.value = '';
  const problem = await store.attachDeviceFiles(files);
  if (problem) attachError.value = problem;
}

function focusInput() { textarea.value?.focus(); }
defineExpose({ focusInput });
</script>

<template>
  <div class="px-3 pb-3 pt-1 safe-bottom sm:px-5 sm:pb-5">
    <div class="relative mx-auto w-full max-w-3xl">
      <!-- Workspace + model + agent pickers -->
      <div class="flex items-center gap-1.5 mb-2 flex-wrap">
        <!-- Active project folder: browse and open another workspace -->
        <button
          class="flex items-center gap-1.5 rounded-lg border hairline bg-[var(--surface)] px-2.5 py-1.5 text-[11.5px] font-medium hover-soft focus-ring max-w-[240px]"
          :class="store.activeWorkspace ? '' : 'border-[var(--amber)]/40 text-[var(--amber)]'"
          :title="store.activeWorkspace
            ? `Workspace: ${store.activeWorkspace.root} — click to open another folder`
            : 'No folder open — choose the project folder the agent may work in'"
          @click="workspaceOpen = true; modelOpen = false; agentOpen = false">
          <FolderOpen :size="13" class="text-[var(--accent-text)] shrink-0" />
          <span class="truncate">{{ store.activeWorkspace?.project.name ?? 'Open folder' }}</span>
          <span v-if="store.activeWorkspace?.isGit" class="flex items-center gap-0.5 text-[9.5px] text-[var(--faint)] shrink-0">
            <GitBranch :size="9" />{{ store.activeWorkspace.branch ?? 'git' }}
          </span>
          <ChevronDown :size="12" class="text-[var(--faint)] shrink-0" />
        </button>

        <div class="relative">
          <button
            class="flex items-center gap-1.5 rounded-lg border hairline bg-[var(--surface)] px-2.5 py-1.5 text-[11.5px] font-medium hover-soft focus-ring"
            @click="modelOpen = !modelOpen; agentOpen = false"
          >
            <Cpu :size="13" class="text-[var(--accent-text)]" />
            <span class="max-w-[190px] truncate">{{ store.selectedModel?.displayName ?? 'Select model' }}</span>
            <span v-if="store.selectedModel" class="text-[var(--faint)]">{{ store.selectedModel.platform }}</span>
            <ChevronDown :size="12" class="text-[var(--faint)]" />
          </button>
          <div v-if="modelOpen" class="absolute bottom-full mb-2 left-0 z-30 w-[320px] surface rounded-xl shadow-[var(--shadow)] overflow-hidden fade-up">
            <div class="p-2 border-b hairline">
              <input v-model="modelFilter" placeholder="Filter 100+ models…" autofocus
                class="w-full bg-[var(--surface-3)] rounded-lg px-2.5 py-1.5 text-[12px] outline-none focus:ring-2 focus:ring-[var(--accent)]" />
            </div>
            <div class="max-h-72 overflow-y-auto">
              <div v-for="[platform, list] in groupedModels" :key="platform">
                <div class="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)] sticky top-0 bg-[var(--surface)]">{{ platform }}</div>
                <button v-for="m in list" :key="m.id"
                  class="w-full text-left px-3 py-1.5 text-[12px] flex items-center justify-between gap-2 hover-soft"
                  :class="{ 'bg-[var(--accent-soft)]': store.selectedModel?.id === m.id }"
                  @click="chooseModel(m.platform, m.modelId)">
                  <span class="truncate">{{ m.displayName }}</span>
                  <span class="text-[10px] text-[var(--faint)] shrink-0">#{{ m.intelligenceRank }}</span>
                </button>
              </div>
              <div v-if="!groupedModels.length" class="p-4 text-center text-[12px] text-[var(--muted)]">No tool-capable model with a key.</div>
            </div>
          </div>
        </div>

        <div class="relative">
          <button
            class="flex items-center gap-1.5 rounded-lg border hairline bg-[var(--surface)] px-2.5 py-1.5 text-[11.5px] font-medium hover-soft focus-ring"
            @click="agentOpen = !agentOpen; modelOpen = false"
          >
            <component :is="currentAgent.icon" :size="13" class="text-[var(--accent-text)]" />
            {{ currentAgent.label }}
            <ChevronDown :size="12" class="text-[var(--faint)]" />
          </button>
          <div v-if="agentOpen" class="absolute bottom-full mb-2 left-0 z-30 w-64 surface rounded-xl shadow-[var(--shadow)] p-1 fade-up">
            <button v-for="mode in agentModes" :key="mode.value"
              class="w-full flex items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover-soft"
              :class="{ 'bg-[var(--accent-soft)]': currentAgent.value === mode.value }"
              @click="chooseAgent(mode.value)">
              <component :is="mode.icon" :size="14" class="mt-0.5 text-[var(--accent-text)] shrink-0" />
              <span><span class="block text-[12px] font-medium">{{ mode.label }}</span><span class="block text-[11px] text-[var(--muted)]">{{ mode.hint }}</span></span>
            </button>
          </div>
        </div>

        <div class="flex items-center gap-1 rounded-lg px-2 py-1.5 text-[11px] text-[var(--muted)]" :title="`Permission mode: ${store.settings.permissionMode}`">
          <ShieldCheck :size="13" /> {{ store.settings.permissionMode }}
        </div>
      </div>

      <!-- Input -->
      <div
        class="surface rounded-2xl shadow-[var(--shadow)] focus-within:border-[var(--accent)] transition-colors"
        :class="dragging ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/25' : ''"
        @dragover.prevent="dragging = true"
        @dragleave.prevent="dragging = false"
        @drop.prevent="onDrop"
      >
        <!-- Attachment tray -->
        <div v-if="store.attachments.length" class="flex items-center gap-1.5 flex-wrap px-3 pt-2.5">
          <div v-for="draft in store.attachments" :key="draft.key"
            class="group flex items-center gap-1.5 rounded-lg border hairline bg-[var(--surface-2)] pl-1.5 pr-1 py-1 max-w-[240px]">
            <component :is="iconFor(draft.name)" :size="12" class="text-[var(--accent-text)] shrink-0" />
            <span class="text-[10.5px] font-mono truncate" :title="draft.path">{{ draft.name }}</span>
            <span class="text-[9px] text-[var(--faint)] shrink-0">{{ sizeLabel(draft.size) }}</span>
            <span v-if="draft.external" class="text-[8.5px] px-1 rounded bg-[var(--blue-soft)] text-[var(--blue)] shrink-0">ext</span>
            <button class="p-0.5 rounded hover:bg-[var(--red-soft)] text-[var(--faint)] hover:text-[var(--red)] shrink-0"
              :title="`Remove ${draft.name}`" @click="store.removeAttachment(draft.key)">
              <X :size="11" />
            </button>
          </div>
          <button class="text-[10px] text-[var(--muted)] hover:text-[var(--text)] px-1" @click="store.clearAttachments()">Clear all</button>
        </div>

        <textarea
          ref="textarea" v-model="text" rows="1"
          :placeholder="store.attachments.length
            ? `Tell the agent what to do with ${store.attachments.length} attached file${store.attachments.length === 1 ? '' : 's'}…`
            : (store.currentSession?.agent === 'plan' ? 'Describe what you want planned…' : 'Ask CodingAgent to build, fix or explain something…')"
          class="block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[14px] leading-6 outline-none placeholder:text-[var(--faint)] max-h-[220px] overflow-y-auto"
          @keydown="onKeydown"
        />
        <div class="flex items-center justify-between gap-2 px-3 pb-2.5 pt-1">
          <div class="flex items-center gap-1.5 min-w-0">
            <button class="p-1.5 rounded-lg hover-soft text-[var(--muted)] hover:text-[var(--text)] shrink-0"
              title="Attach files (workspace or this device)" @click="pickerOpen = true">
              <Paperclip :size="15" />
            </button>
            <span v-if="store.attachments.length" class="text-[10px] text-[var(--faint)] truncate">
              {{ store.attachments.length }} attached<span v-if="totalTokens"> · ~{{ totalTokens.toLocaleString() }} tok</span>
            </span>
            <span v-else class="text-[10.5px] text-[var(--faint)] pl-0.5 hidden sm:block">Enter to send · Shift+Enter for newline · drop files to attach</span>
            <span v-if="!store.attachments.length" class="text-[10.5px] text-[var(--faint)] pl-0.5 sm:hidden">Enter to send</span>
          </div>
          <button v-if="store.running" @click="store.abort()"
            class="flex items-center gap-1.5 rounded-xl bg-[var(--red)] text-white px-3.5 py-1.5 text-[12px] font-medium hover:opacity-90 focus-ring shrink-0">
            <Square :size="12" fill="currentColor" /> Stop
          </button>
          <button v-else :disabled="!text.trim() && !store.attachments.length" @click="submit"
            class="flex items-center gap-1.5 rounded-xl bg-[var(--accent)] text-white px-3.5 py-1.5 text-[12px] font-medium hover:bg-[var(--accent-hover)] focus-ring disabled:bg-[var(--surface-3)] disabled:text-[var(--faint)] shrink-0">
            <ArrowUp :size="14" /> Send
          </button>
        </div>
      </div>

      <div v-if="attachError" class="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-[var(--amber)]">
        <X :size="11" class="cursor-pointer" @click="attachError = ''" />{{ attachError }}
      </div>
      <p class="text-center text-[10px] text-[var(--faint)] mt-2">AI can make mistakes. Review file changes before committing.</p>
    </div>

    <AttachmentPicker :open="pickerOpen" @close="pickerOpen = false" />
    <WorkspaceModal :open="workspaceOpen" @close="workspaceOpen = false" />
  </div>
</template>
