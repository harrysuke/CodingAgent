<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  Terminal, X, Eraser, Square, RotateCcw, Loader2, Sparkles, PackagePlus, Trash2,
  Check, AlertTriangle, ChevronDown, ChevronRight, ChevronUp, Wand2, ShieldCheck, Braces,
  FolderGit2, Search, Copy, Clipboard, Settings, Download, Plus, Minus, Bell, Monitor,
  FileText, RefreshCw,
} from 'lucide-vue-next';
import { useAppStore } from '../stores/app';
import TerminalView from './TerminalView.vue';

type Renderer = 'auto' | 'webgl' | 'canvas' | 'dom';
interface TerminalViewApi {
  focus(): void;
  fit(): void;
  clear(): void;
  selectAll(): void;
  scrollToBottom(): void;
  copySelection(): Promise<void>;
  pasteClipboard(): Promise<void>;
  findNext(query: string, options?: Record<string, unknown>): boolean;
  findPrevious(query: string, options?: Record<string, unknown>): boolean;
  clearSearch(): void;
  setFontSize(size: number): void;
  changeFontSize(delta: number): void;
  setRenderer(kind: Renderer): void;
  setCopyOnSelect(value: boolean): void;
  serializeText(): string;
  getFontSize(): number;
  getRenderer(): Renderer;
  getCopyOnSelect(): boolean;
}

const store = useAppStore();
const emit = defineEmits<{ (e: 'close'): void }>();

const tab = ref<'terminal' | 'skills'>('terminal');
const views = new Map<string, TerminalViewApi>();

// --- dock sizing -----------------------------------------------------------
const LS_HEIGHT = 'codingagent.terminalHeight';
const panelHeight = ref(Number(localStorage.getItem(LS_HEIGHT)) || 320);

function startResize(event: PointerEvent): void {
  const handle = event.currentTarget as HTMLElement;
  const startY = event.clientY;
  const startHeight = panelHeight.value;
  handle.setPointerCapture(event.pointerId);
  const move = (ev: PointerEvent) => {
    panelHeight.value = Math.max(160, Math.min(window.innerHeight * 0.78, startHeight + (startY - ev.clientY)));
  };
  const up = () => {
    localStorage.setItem(LS_HEIGHT, String(Math.round(panelHeight.value)));
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    for (const view of views.values()) view.fit();
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
}

// --- tabs ------------------------------------------------------------------
function setViewRef(id: string, el: unknown): void {
  if (el) views.set(id, el as TerminalViewApi);
  else views.delete(id);
}
function activeView(): TerminalViewApi | null {
  const id = store.activeTerminalId;
  return id ? views.get(id) ?? null : null;
}
function viewIsActive(id: string): boolean {
  return store.terminalOpen && tab.value === 'terminal' && store.activeTerminalId === id;
}

const shellMenuOpen = ref(false);
const settingsOpen = ref(false);
const bellRinging = ref(false);
let bellTimer: ReturnType<typeof setTimeout> | null = null;

function onBell(): void {
  bellRinging.value = true;
  if (bellTimer) clearTimeout(bellTimer);
  bellTimer = setTimeout(() => { bellRinging.value = false; }, 1200);
}

async function newTab(shell?: string): Promise<void> {
  shellMenuOpen.value = false;
  const created = await store.createTerminalTab({ shell });
  if (created) tab.value = 'terminal';
}

function activateTab(id: string): void {
  store.activeTerminalId = id;
  tab.value = 'terminal';
  void nextTick(() => activeView()?.focus());
}

function closeTab(id: string): void {
  views.delete(id);
  void store.closeTerminalTab(id);
}

watch(() => store.activeTerminalId, id => {
  if (id && viewIsActive(id)) void nextTick(() => views.get(id)?.focus());
});
watch(() => store.terminalOpen, open => {
  if (open) void store.loadTerminalShells();
  else { shellMenuOpen.value = false; settingsOpen.value = false; }
});

// --- search ----------------------------------------------------------------
const searchOpen = ref(false);
const searchTerm = ref('');
const searchCase = ref(false);
const searchWord = ref(false);
const searchRegex = ref(false);
const searchMiss = ref(false);
const searchInput = ref<HTMLInputElement | null>(null);

function searchOptions(): Record<string, unknown> {
  return { caseSensitive: searchCase.value, wholeWord: searchWord.value, regex: searchRegex.value };
}
function find(next: boolean): void {
  const view = activeView();
  if (!view || !searchTerm.value) return;
  searchMiss.value = next
    ? !view.findNext(searchTerm.value, searchOptions())
    : !view.findPrevious(searchTerm.value, searchOptions());
}
function openSearch(): void {
  searchOpen.value = true;
  tab.value = 'terminal';
  void nextTick(() => searchInput.value?.focus());
}
function closeSearch(): void {
  searchOpen.value = false;
  searchMiss.value = false;
  activeView()?.clearSearch();
  activeView()?.focus();
}
watch(searchTerm, () => { searchMiss.value = false; });

/** Ctrl+Shift+F works even when focus is outside the Xterm.js viewport. */
function onGlobalKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f' && store.terminalOpen) {
    event.preventDefault();
    openSearch();
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onGlobalKeydown);
  if (bellTimer) clearTimeout(bellTimer);
});

// --- toolbar ---------------------------------------------------------------
function clear(): void {
  activeView()?.clear();
  void store.clearTerminal(store.activeTerminalId ?? undefined);
}
function downloadTranscript(): void {
  const text = activeView()?.serializeText() ?? '';
  if (!text.trim()) return;
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `codingagent-terminal-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.log`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  settingsOpen.value = false;
}
const renderer = ref<Renderer>('auto');
const copyOnSelect = ref(true);
const fontLabel = ref(12);
function openSettings(): void {
  const view = activeView();
  if (view) {
    renderer.value = view.getRenderer();
    copyOnSelect.value = view.getCopyOnSelect();
    fontLabel.value = view.getFontSize();
  }
  settingsOpen.value = !settingsOpen.value;
}
function changeFont(delta: number): void {
  activeView()?.changeFontSize(delta);
  fontLabel.value = activeView()?.getFontSize() ?? fontLabel.value;
}
function setRenderer(kind: Renderer): void {
  renderer.value = kind;
  activeView()?.setRenderer(kind);
}
function toggleCopyOnSelect(): void {
  copyOnSelect.value = !copyOnSelect.value;
  activeView()?.setCopyOnSelect(copyOnSelect.value);
}

const activeTab = computed(() => store.activeTerminal);
const shellOptions = computed(() => store.terminalShellOptions.filter(s => s.available));

// --- skills (unchanged behaviour: install log is echoed into the shell) -----
const skillSource = ref('');
const skillScope = ref<'workspace' | 'user'>('workspace');
const showLog = ref(false);
const installError = ref('');
const skillDirs = computed(() => store.skillDirectories);

async function install(): Promise<void> {
  const source = skillSource.value.trim();
  if (!source) return;
  installError.value = '';
  store.pushTerminalLine({ stream: 'input', data: `\x1b[36m$ skills install ${source}\x1b[0m\n`, at: new Date().toISOString() });
  try {
    const result = await store.installSkill(source, skillScope.value);
    for (const line of result.log) {
      store.pushTerminalLine({ stream: 'system', data: `${line}\n`, at: new Date().toISOString() });
    }
    store.pushTerminalLine({
      stream: 'system',
      data: `${result.installed.length} skill(s) installed and injected into the agent's system prompt.\n`,
      at: new Date().toISOString(),
    });
    skillSource.value = '';
    showLog.value = true;
  } catch (err) {
    installError.value = (err as Error).message;
    store.pushTerminalLine({ stream: 'stderr', data: `${(err as Error).message}\n`, at: new Date().toISOString() });
  }
}

async function installBuiltin(name: string): Promise<void> {
  skillSource.value = `builtin:${name}`;
  await install();
}

function toolSummary(skill: { toolDefaults: Record<string, Record<string, unknown>> }): string {
  const entries = Object.entries(skill.toolDefaults ?? {});
  if (!entries.length) return '';
  return entries.map(([tool, params]) => `${tool}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')})`).join(' · ');
}

watch(tab, value => {
  if (value === 'skills') void store.loadSkills();
  if (value === 'terminal') void nextTick(() => activeView()?.focus());
});
</script>

<template>
  <section class="shrink-0 border-t hairline bg-[var(--surface-2)] flex flex-col relative"
    :style="{ height: `${panelHeight}px` }">
    <!-- Drag handle -->
    <div class="absolute -top-1 left-0 right-0 h-2 cursor-ns-resize z-30 group" title="Drag to resize"
      @pointerdown="startResize">
      <div class="mx-auto w-10 h-0.5 mt-[3px] rounded-full bg-[var(--border-strong)] opacity-0 group-hover:opacity-100 transition-opacity" />
    </div>

    <!-- Header -->
    <div class="flex items-center gap-1 h-10 px-2 border-b hairline shrink-0">
      <button class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium shrink-0"
        :class="tab === 'terminal' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--muted)] hover-soft'"
        @click="tab = 'terminal'">
        <Terminal :size="13" /> Terminal
        <span v-if="store.terminalTabs.length" class="text-[9.5px] rounded-full bg-[var(--surface-3)] px-1.5">{{ store.terminalTabs.length }}</span>
      </button>
      <button class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium shrink-0"
        :class="tab === 'skills' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--muted)] hover-soft'"
        @click="tab = 'skills'">
        <Sparkles :size="13" /> Skills
        <span v-if="store.skills.length" class="text-[9.5px] rounded-full bg-[var(--surface-3)] px-1.5">{{ store.skills.length }}</span>
      </button>

      <div class="flex-1 min-w-0" />
      <span v-if="tab === 'terminal'" class="hidden md:flex items-center gap-1 text-[10px] font-mono text-[var(--faint)] truncate max-w-[240px]"
        :title="activeTab?.cwd || store.activeWorkspace?.root">
        <FolderGit2 :size="10" /> {{ activeTab?.cwd || store.activeWorkspace?.root || 'workspace' }}
      </span>
      <Bell v-if="bellRinging" :size="12" class="text-[var(--amber)] shrink-0" />

      <template v-if="tab === 'terminal'">
        <button class="p-1.5 rounded hover-soft text-[var(--muted)] shrink-0" title="Search scrollback (Ctrl+Shift+F)" @click="openSearch"><Search :size="13" /></button>
        <button class="p-1.5 rounded hover-soft text-[var(--muted)] shrink-0" title="Interrupt (Ctrl+C)" @click="store.interruptTerminal(store.activeTerminalId ?? undefined)"><Square :size="12" /></button>
        <button class="p-1.5 rounded hover-soft text-[var(--muted)] shrink-0" title="Restart shell" @click="store.restartTerminal(store.activeTerminalId ?? undefined)"><RotateCcw :size="13" /></button>
        <button class="p-1.5 rounded hover-soft text-[var(--muted)] shrink-0" title="Clear viewport" @click="clear"><Eraser :size="13" /></button>
        <button class="p-1.5 rounded hover-soft text-[var(--muted)] hidden sm:block shrink-0" title="Copy selection (Ctrl+Shift+C)" @click="activeView()?.copySelection()"><Copy :size="13" /></button>
        <button class="p-1.5 rounded hover-soft text-[var(--muted)] hidden sm:block shrink-0" title="Paste (Ctrl+Shift+V)" @click="activeView()?.pasteClipboard()"><Clipboard :size="13" /></button>
        <div class="relative shrink-0">
          <button class="p-1.5 rounded hover-soft text-[var(--muted)]" title="Terminal settings" @click="openSettings"><Settings :size="13" /></button>
          <div v-if="settingsOpen" class="absolute right-0 top-8 z-40 w-56 rounded-xl border hairline surface p-2.5 shadow-[var(--shadow)] space-y-2.5">
            <div class="flex items-center justify-between text-[10.5px] text-[var(--muted)]">
              <span>Font size</span>
              <div class="flex items-center gap-1">
                <button class="p-1 rounded hover-soft" title="Smaller (Ctrl+-)" @click="changeFont(-1)"><Minus :size="11" /></button>
                <span class="font-mono w-6 text-center text-[var(--text)]">{{ fontLabel }}</span>
                <button class="p-1 rounded hover-soft" title="Larger (Ctrl++)" @click="changeFont(1)"><Plus :size="11" /></button>
              </div>
            </div>
            <label class="flex items-center justify-between gap-2 text-[10.5px] text-[var(--muted)]">
              <span>Renderer</span>
              <select :value="renderer" class="bg-[var(--surface-3)] rounded px-1.5 py-1 text-[10.5px] outline-none"
                @change="setRenderer(($event.target as HTMLSelectElement).value as Renderer)">
                <option value="auto">Auto (WebGL)</option>
                <option value="webgl">WebGL</option>
                <option value="canvas">Canvas</option>
                <option value="dom">DOM</option>
              </select>
            </label>
            <label class="flex items-center gap-2 text-[10.5px] text-[var(--muted)] cursor-pointer">
              <input type="checkbox" :checked="copyOnSelect" class="accent-[var(--accent)]" @change="toggleCopyOnSelect" />
              Copy on selection
            </label>
            <button class="flex items-center gap-1.5 w-full rounded-md px-1.5 py-1 text-[10.5px] hover-soft text-left"
              @click="downloadTranscript"><Download :size="11" /> Save transcript as .log</button>
            <div class="border-t hairline pt-2 text-[9.5px] leading-relaxed text-[var(--faint)]">
              Ctrl+Shift+C/V copy &amp; paste · Ctrl+Shift+F search · Ctrl+Shift+A select all · Ctrl +/- font · right-click to paste
            </div>
          </div>
        </div>
      </template>
      <button class="p-1.5 rounded hover-soft text-[var(--muted)] shrink-0" title="Close panel" @click="emit('close')"><X :size="14" /></button>
    </div>

    <!-- Capability / fallback banners -->
    <div v-if="tab === 'terminal' && store.terminalOutdated"
      class="shrink-0 flex items-start gap-2 px-3 py-2 bg-[var(--amber-soft)] text-[var(--amber)] text-[11px] border-b hairline">
      <AlertTriangle :size="13" class="shrink-0 mt-0.5" />
      <span>The server is running an older build without PTY support. Restart the CodingAgent server and reload this page to use the new terminal.</span>
    </div>
    <div v-else-if="tab === 'terminal' && activeTab && !activeTab.pty"
      class="shrink-0 flex items-start gap-2 px-3 py-1.5 bg-[var(--amber-soft)] text-[var(--amber)] text-[10.5px] border-b hairline">
      <AlertTriangle :size="12" class="shrink-0 mt-0.5" />
      <span>Limited mode: the native PTY addon could not load, so interactive programs and arrow keys are unavailable.</span>
    </div>
    <div v-if="tab === 'terminal' && store.terminalError"
      class="shrink-0 flex items-center gap-2 px-3 py-1.5 bg-[var(--red-soft)] text-[var(--red)] text-[10.5px] border-b hairline">
      <AlertTriangle :size="12" /> <span class="flex-1 truncate">{{ store.terminalError }}</span>
      <button title="Retry" @click="store.createTerminalTab()"><RefreshCw :size="11" /></button>
    </div>

    <!-- Terminal tabs -->
    <div v-if="tab === 'terminal'" class="flex items-center gap-1 h-8 px-2 border-b hairline shrink-0 overflow-x-auto">
      <div v-for="shellTab in store.terminalTabs" :key="shellTab.id"
        class="flex items-center gap-1 rounded-t-md px-2 h-6 shrink-0 text-[10.5px] cursor-pointer border hairline"
        :class="store.activeTerminalId === shellTab.id
          ? 'bg-[var(--code-bg)] text-[var(--text)] border-b-transparent'
          : 'bg-[var(--surface-3)] text-[var(--muted)] hover-soft'"
        :title="`${shellTab.shell} — ${shellTab.cwd}`"
        @click="activateTab(shellTab.id)">
        <span class="w-1.5 h-1.5 rounded-full shrink-0" :class="shellTab.running ? 'bg-[var(--green)]' : 'bg-[var(--faint)]'" />
        <span class="max-w-[120px] truncate">{{ shellTab.title }}</span>
        <span class="text-[9px] px-1 rounded bg-[var(--surface-3)] font-mono">{{ shellTab.pty ? 'pty' : 'pipe' }}</span>
        <button class="p-0.5 rounded hover-soft" title="Close shell" @click.stop="closeTab(shellTab.id)"><X :size="10" /></button>
      </div>
      <div class="relative shrink-0">
        <button class="flex items-center gap-0.5 h-6 px-1.5 rounded-md text-[10.5px] text-[var(--muted)] hover-soft"
          title="New shell tab" @click="shellMenuOpen = !shellMenuOpen">
          <Plus :size="12" /><ChevronDown :size="9" />
        </button>
        <div v-if="shellMenuOpen" class="absolute left-0 top-7 z-40 w-44 rounded-xl border hairline surface p-1 shadow-[var(--shadow)]">
          <button v-for="shell in shellOptions" :key="shell.id"
            class="flex items-center gap-1.5 w-full text-left rounded-md px-2 py-1.5 text-[10.5px] hover-soft"
            :title="shell.command" @click="newTab(shell.id)">
            <Monitor :size="11" /> {{ shell.label }}
          </button>
          <button v-if="!shellOptions.length" class="w-full text-left rounded-md px-2 py-1.5 text-[10.5px] hover-soft"
            @click="newTab()">Default shell</button>
        </div>
      </div>
      <div class="flex-1" />
      <span v-if="store.terminalBusy" class="flex items-center gap-1 text-[10px] text-[var(--muted)] shrink-0">
        <Loader2 :size="10" class="animate-spin" /> starting shell…
      </span>
    </div>

    <!-- Search bar -->
    <div v-show="tab === 'terminal' && searchOpen"
      class="flex items-center gap-1.5 h-9 px-2 border-b hairline shrink-0 bg-[var(--surface)]">
      <Search :size="12" class="text-[var(--muted)] shrink-0" />
      <input ref="searchInput" v-model="searchTerm" spellcheck="false" placeholder="Find in terminal…"
        class="flex-1 min-w-0 bg-transparent text-[11px] font-mono outline-none"
        :class="searchMiss ? 'text-[var(--red)]' : 'text-[var(--text)]'"
        @keydown.enter.prevent="find(true)" @keydown.shift.enter.prevent="find(false)" @keydown.esc.prevent="closeSearch" />
      <button class="px-1.5 py-0.5 rounded text-[9.5px] font-mono hover-soft" :class="searchCase ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--faint)]'"
        title="Match case" @click="searchCase = !searchCase">Aa</button>
      <button class="px-1.5 py-0.5 rounded text-[9.5px] font-mono hover-soft" :class="searchWord ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--faint)]'"
        title="Whole word" @click="searchWord = !searchWord">W</button>
      <button class="px-1.5 py-0.5 rounded text-[9.5px] font-mono hover-soft" :class="searchRegex ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--faint)]'"
        title="Regular expression" @click="searchRegex = !searchRegex">.*</button>
      <span v-if="searchMiss" class="text-[9.5px] text-[var(--red)]">no match</span>
      <button class="p-1 rounded hover-soft text-[var(--muted)]" title="Previous (Shift+Enter)" @click="find(false)"><ChevronUp :size="12" /></button>
      <button class="p-1 rounded hover-soft text-[var(--muted)]" title="Next (Enter)" @click="find(true)"><ChevronDown :size="12" /></button>
      <button class="p-1 rounded hover-soft text-[var(--muted)]" title="Close search" @click="closeSearch"><X :size="12" /></button>
    </div>

    <!-- Xterm.js viewports: keep every tab mounted (and its scrollback alive)
         even while the Skills tab or the whole dock is hidden. -->
    <div v-show="tab === 'terminal'" class="flex-1 min-h-0 relative bg-[var(--code-bg)]">
      <div v-for="shellTab in store.terminalTabs" :key="shellTab.id" v-show="viewIsActive(shellTab.id)" class="absolute inset-0">
        <TerminalView :ref="el => setViewRef(shellTab.id, el)" :terminal-id="shellTab.id" :active="viewIsActive(shellTab.id)"
          @title="title => store.renameTerminalTab(shellTab.id, title.slice(0, 28) || shellTab.title)"
          @bell="onBell" @search="openSearch" />
      </div>
      <div v-if="!store.terminalTabs.length && !store.terminalBusy"
        class="absolute inset-0 grid place-items-center text-center px-6">
        <div class="text-[11.5px] text-[var(--faint)] max-w-md leading-relaxed">
          <Terminal :size="22" class="mx-auto mb-2 opacity-60" />
          No shell is open. A real PTY is started in this session's project folder —
          run builds, git, package managers or full-screen programs like vim and less.
          <div class="mt-3">
            <button class="rounded-lg bg-[var(--accent)] text-white px-3 py-1.5 text-[11px] font-medium hover:bg-[var(--accent-hover)]"
              @click="newTab()">Open a terminal</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Status bar -->
    <div v-show="tab === 'terminal'"
      class="flex items-center gap-2 h-6 px-2.5 border-t hairline shrink-0 text-[9.5px] font-mono text-[var(--faint)] bg-[var(--surface)]">
      <span class="flex items-center gap-1 shrink-0" :class="activeTab?.running ? 'text-[var(--green)]' : 'text-[var(--red)]'">
        <span class="w-1.5 h-1.5 rounded-full" :class="activeTab?.running ? 'bg-[var(--green)]' : 'bg-[var(--red)]'" />
        {{ activeTab?.running ? 'connected' : 'offline' }}
      </span>
      <span class="shrink-0">{{ activeTab?.shell || '—' }}</span>
      <span class="shrink-0 px-1 rounded bg-[var(--surface-3)]">{{ activeTab?.pty ? 'PTY · xterm-256color' : 'pipe · limited' }}</span>
      <span class="truncate flex-1 text-right" :title="activeTab?.cwd">{{ activeTab?.cwd || '' }}</span>
      <span class="shrink-0">{{ activeTab?.cols }}×{{ activeTab?.rows }}</span>
    </div>

    <!-- Skills -->
    <div v-show="tab === 'skills'" class="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 space-y-3">
        <div class="rounded-xl border hairline bg-[var(--surface)] p-2.5">
          <div class="flex items-center gap-1.5 text-[11px] font-semibold mb-1.5">
            <PackagePlus :size="13" class="text-[var(--accent-text)]" /> Install an Agent Skill
          </div>
          <div class="flex items-center gap-1.5">
            <input v-model="skillSource" spellcheck="false"
              placeholder="git URL, owner/repo, or a local path to SKILL.md"
              class="flex-1 min-w-0 bg-[var(--surface-3)] rounded-lg px-2 py-1.5 text-[11px] font-mono outline-none focus:ring-2 focus:ring-[var(--accent)]"
              @keydown.enter.prevent="install" />
            <select v-model="skillScope" class="bg-[var(--surface-3)] rounded-lg px-1.5 py-1.5 text-[11px] outline-none">
              <option value="workspace">workspace</option>
              <option value="user">user</option>
            </select>
            <button class="flex items-center gap-1 rounded-lg bg-[var(--accent)] text-white px-2.5 py-1.5 text-[11px] font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40"
              :disabled="store.skillsBusy || !skillSource.trim()" @click="install">
              <Loader2 v-if="store.skillsBusy" :size="11" class="animate-spin" /><Wand2 v-else :size="11" /> Install
            </button>
          </div>
          <div class="flex items-center gap-1.5 mt-1.5 flex-wrap">
            <span class="text-[10px] text-[var(--faint)]">Starters:</span>
            <button class="flex items-center gap-1 rounded-md border hairline px-1.5 py-0.5 text-[10px] hover-soft" @click="installBuiltin('code-review')">
              <ShieldCheck :size="9" /> code-review
            </button>
            <button class="flex items-center gap-1 rounded-md border hairline px-1.5 py-0.5 text-[10px] hover-soft" @click="installBuiltin('test-first')">
              <Braces :size="9" /> test-first
            </button>
            <span class="text-[10px] text-[var(--faint)] ml-auto font-mono truncate max-w-[220px]" :title="skillDirs[0]?.path">
              → {{ skillDirs[0]?.path ?? '.codingagent/skills' }}
            </span>
          </div>
          <p v-if="installError" class="mt-1.5 flex items-start gap-1.5 text-[10.5px] text-[var(--red)]">
            <AlertTriangle :size="11" class="shrink-0 mt-0.5" />{{ installError }}
          </p>
        </div>

        <div v-if="!store.skills.length" class="text-center text-[11px] text-[var(--faint)] py-4">
          No skills installed. A skill adds standing instructions and tool defaults to every turn in this workspace.
        </div>
        <div v-else class="space-y-1.5">
          <div v-for="skill in store.skills" :key="skill.id" class="rounded-xl border hairline bg-[var(--surface)] px-2.5 py-2">
            <div class="flex items-center gap-2">
              <button class="w-7 h-4 rounded-full relative shrink-0 transition-colors"
                :class="skill.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--surface-3)] border hairline'"
                :title="skill.enabled ? 'Disable' : 'Enable'"
                @click="store.toggleSkill(skill.id, !skill.enabled)">
                <span class="absolute top-0.5 w-3 h-3 rounded-full bg-white transition-all" :style="{ left: skill.enabled ? '14px' : '2px' }" />
              </button>
              <span class="text-[11.5px] font-medium truncate">{{ skill.name }}</span>
              <span class="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--surface-3)] text-[var(--muted)] shrink-0">v{{ skill.version }}</span>
              <span class="text-[9.5px] px-1.5 py-0.5 rounded shrink-0"
                :class="skill.scope === 'workspace' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'bg-[var(--blue-soft)] text-[var(--blue)]'">{{ skill.scope }}</span>
              <span v-if="skill.enabled" class="flex items-center gap-0.5 text-[9.5px] text-[var(--green)] shrink-0"><Check :size="9" /> active</span>
              <div class="flex-1" />
              <button class="p-1 rounded hover-soft text-[var(--red)] shrink-0" title="Remove skill" @click="store.removeSkill(skill.id)"><Trash2 :size="11" /></button>
            </div>
            <p v-if="skill.description" class="text-[10.5px] text-[var(--muted)] mt-1 leading-snug">{{ skill.description }}</p>
            <div class="flex items-center gap-1 flex-wrap mt-1">
              <span v-for="tool in skill.allowedTools" :key="tool"
                class="text-[9.5px] font-mono px-1 py-0.5 rounded bg-[var(--surface-3)] text-[var(--muted)]">{{ tool }}</span>
              <span v-if="toolSummary(skill)" class="text-[9.5px] font-mono text-[var(--faint)] truncate">{{ toolSummary(skill) }}</span>
            </div>
          </div>
        </div>

        <div v-if="store.skillsLog.length">
          <button class="flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]" @click="showLog = !showLog">
            <ChevronDown v-if="showLog" :size="10" /><ChevronRight v-else :size="10" /> Install log
            <FileText :size="10" />
          </button>
          <pre v-if="showLog" class="mt-1 max-h-32 overflow-auto rounded-lg bg-[var(--code-bg)] border hairline p-2 text-[10px] font-mono whitespace-pre-wrap">{{ store.skillsLog.join('\n') }}</pre>
        </div>
    </div>
  </section>
</template>
