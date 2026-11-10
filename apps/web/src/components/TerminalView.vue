<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { Terminal as XtermTerminal, type ITheme, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon, type ISearchOptions } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import { SerializeAddon } from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
import type { TerminalChunk } from '@codingagent/shared';
import { useAppStore } from '../stores/app';

const props = defineProps<{ terminalId: string; active: boolean }>();
const emit = defineEmits<{
  (e: 'title', value: string): void;
  (e: 'bell'): void;
  (e: 'size', cols: number, rows: number): void;
  (e: 'search'): void;
  (e: 'activity'): void;
}>();

const store = useAppStore();
const host = ref<HTMLElement | null>(null);

const LS_FONT = 'codingagent.terminalFontSize';
const LS_COPY = 'codingagent.terminalCopyOnSelect';
const LS_RENDERER = 'codingagent.terminalRenderer';

type Renderer = 'auto' | 'webgl' | 'canvas' | 'dom';

const fontSize = ref(Number(localStorage.getItem(LS_FONT)) || 12);
const copyOnSelect = ref(localStorage.getItem(LS_COPY) !== 'false');
const rendererKind = ref<Renderer>((localStorage.getItem(LS_RENDERER) as Renderer) || 'auto');

let term: XtermTerminal | null = null;
let fitAddon: FitAddon | null = null;
let searchAddon: SearchAddon | null = null;
let serializeAddon: SerializeAddon | null = null;
let rendererAddon: IDisposable | null = null;
let unsubscribe: (() => void) | null = null;
let resizeObserver: ResizeObserver | null = null;
let themeObserver: MutationObserver | null = null;
const disposables: IDisposable[] = [];
let resizeTimer: ReturnType<typeof setTimeout> | null = null;
let fitTimer: ReturnType<typeof setTimeout> | null = null;

/** Raw PTY bytes are batched into one write per frame to keep replay cheap. */
let pending = '';
let writeTimer: ReturnType<typeof setTimeout> | null = null;

const SEARCH_DECORATIONS: ISearchOptions['decorations'] = {
  matchBackground: '#9a670033',
  matchBorder: '#9a670000',
  matchOverviewRuler: '#9a6700',
  activeMatchBackground: '#4f46e566',
  activeMatchBorder: '#4f46e500',
  activeMatchColorOverviewRuler: '#4f46e5',
};

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Xterm.js has its own palette, so map the app's light/dark tokens onto it. */
function currentTheme(): ITheme {
  const dark = document.documentElement.classList.contains('dark');
  return {
    background: cssVar('--code-bg', dark ? '#0b1017' : '#f5f7fa'),
    foreground: cssVar('--text', dark ? '#e6edf3' : '#151a22'),
    cursor: cssVar('--accent-text', dark ? '#a5b0ff' : '#4338ca'),
    cursorAccent: cssVar('--code-bg', dark ? '#0b1017' : '#f5f7fa'),
    selectionBackground: dark ? '#2b4270' : '#b9d3ff',
    selectionForeground: dark ? '#ffffff' : '#101828',
    selectionInactiveBackground: dark ? '#22304a' : '#dbe6f7',
    black: dark ? '#484f58' : '#24292f',
    red: dark ? '#ff7b72' : '#cf222e',
    green: dark ? '#3fb950' : '#1a7f37',
    yellow: dark ? '#d29922' : '#9a6700',
    blue: dark ? '#58a6ff' : '#0969da',
    magenta: dark ? '#bc8cff' : '#8250df',
    cyan: dark ? '#39c5cf' : '#1b7c83',
    white: dark ? '#b1bac4' : '#6e7781',
    brightBlack: dark ? '#6e7681' : '#57606a',
    brightRed: dark ? '#ffa198' : '#a40e26',
    brightGreen: dark ? '#56d364' : '#1a7f37',
    brightYellow: dark ? '#e3b341' : '#633c01',
    brightBlue: dark ? '#79c0ff' : '#0550ae',
    brightMagenta: dark ? '#d2a8ff' : '#6639ba',
    brightCyan: dark ? '#56d4dd' : '#0e7490',
    brightWhite: dark ? '#f0f6fc' : '#8c959f',
  };
}

function loadRenderer(kind: Renderer): void {
  if (!term) return;
  try { rendererAddon?.dispose(); } catch { /* renderer already gone */ }
  rendererAddon = null;
  if (kind === 'dom') return;
  const useCanvas = () => {
    if (!term) return;
    try {
      const canvas = new CanvasAddon();
      term.loadAddon(canvas);
      rendererAddon = canvas;
    } catch { /* fall back to the DOM renderer */ }
  };
  if (kind === 'canvas') { useCanvas(); return; }
  try {
    const webgl = new WebglAddon();
    term.loadAddon(webgl);
    rendererAddon = webgl;
    disposables.push(webgl.onContextLoss(() => {
      try { webgl.dispose(); } catch { /* already disposed */ }
      rendererAddon = null;
      useCanvas();
    }));
  } catch { useCanvas(); }
}

function flushWrites(): void {
  writeTimer = null;
  const data = pending;
  pending = '';
  if (data && term) term.write(data);
}

function applyChunk(chunk: TerminalChunk): void {
  if (!term) return;
  if (chunk.stream === 'reset') {
    // The server replays its scrollback after this frame. Drop any earlier
    // buffered bytes so a reconnect never duplicates the visible output.
    pending = '';
    term.reset();
    return;
  }
  if (!chunk.data) return;
  pending += chunk.data;
  if (!writeTimer) writeTimer = setTimeout(flushWrites, 8);
  emit('activity');
}

function scheduleFit(): void {
  if (fitTimer) clearTimeout(fitTimer);
  fitTimer = setTimeout(() => fit(), 50);
}

function fit(): void {
  if (!term || !fitAddon || !host.value || !props.active) return;
  const { clientWidth, clientHeight } = host.value;
  if (clientWidth < 60 || clientHeight < 40) return;
  try { fitAddon.fit(); } catch { /* container is transitioning */ }
}

function focus(): void {
  if (props.active) term?.focus();
}

async function copySelection(): Promise<void> {
  if (!term?.hasSelection()) return;
  try { await navigator.clipboard.writeText(term.getSelection()); } catch { /* clipboard denied */ }
}

async function pasteClipboard(): Promise<void> {
  try {
    const text = await navigator.clipboard.readText();
    if (text) term?.paste(text);
  } catch { /* clipboard denied */ }
}

function clear(): void { term?.clear(); }
function selectAll(): void { term?.selectAll(); }
function scrollToBottom(): void { term?.scrollToBottom(); }

function findNext(query: string, options: Omit<ISearchOptions, 'decorations'> = {}): boolean {
  return searchAddon?.findNext(query, { ...options, decorations: SEARCH_DECORATIONS }) ?? false;
}
function findPrevious(query: string, options: Omit<ISearchOptions, 'decorations'> = {}): boolean {
  return searchAddon?.findPrevious(query, { ...options, decorations: SEARCH_DECORATIONS }) ?? false;
}
function clearSearch(): void { searchAddon?.clearDecorations(); }

function setFontSize(size: number): void {
  const clamped = Math.max(9, Math.min(22, Math.round(size)));
  fontSize.value = clamped;
  localStorage.setItem(LS_FONT, String(clamped));
  if (term) term.options.fontSize = clamped;
  void nextTick(scheduleFit);
}
function changeFontSize(delta: number): void { setFontSize(fontSize.value + delta); }

function setRenderer(kind: Renderer): void {
  rendererKind.value = kind;
  localStorage.setItem(LS_RENDERER, kind);
  loadRenderer(kind);
}
function setCopyOnSelect(value: boolean): void {
  copyOnSelect.value = value;
  localStorage.setItem(LS_COPY, String(value));
}

/** ANSI-rich scrollback for "save transcript"; strip escapes for plain text. */
function serialize(): string { return serializeAddon?.serialize() ?? ''; }
function serializeText(): string {
  return serialize()
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007]*\u0007/g, '')
    .replace(/\r/g, '');
}
function writeAnsi(data: string): void { term?.write(data); }

function onContextMenu(event: MouseEvent): void {
  event.preventDefault();
  if (term?.hasSelection()) void copySelection();
  else void pasteClipboard();
}

function attach(): void {
  if (!host.value || term) return;
  const instance = new XtermTerminal({
    allowProposedApi: true,
    allowTransparency: false,
    theme: currentTheme(),
    fontFamily: "'Cascadia Code', 'Cascadia Mono', 'JetBrains Mono', 'SFMono-Regular', Consolas, 'Liberation Mono', monospace",
    fontSize: fontSize.value,
    fontWeight: '400',
    fontWeightBold: '700',
    lineHeight: 1.3,
    letterSpacing: 0,
    cursorBlink: true,
    cursorStyle: 'bar',
    cursorWidth: 2,
    scrollback: 10_000,
    smoothScrollDuration: 80,
    fastScrollModifier: 'alt',
    altClickMovesCursor: true,
    rightClickSelectsWord: true,
    minimumContrastRatio: 4.5,
    drawBoldTextInBrightColors: true,
    overviewRulerWidth: 12,
    cols: store.activeTerminal?.cols || 80,
    rows: store.activeTerminal?.rows || 24,
  });
  term = instance;

  fitAddon = new FitAddon();
  searchAddon = new SearchAddon();
  serializeAddon = new SerializeAddon();
  const unicode11 = new Unicode11Addon();
  instance.loadAddon(fitAddon);
  instance.loadAddon(searchAddon);
  instance.loadAddon(serializeAddon);
  instance.loadAddon(unicode11);
  instance.unicode.activeVersion = '11';
  instance.loadAddon(new WebLinksAddon((_event, uri) => {
    window.open(uri, '_blank', 'noopener,noreferrer');
  }));
  // OSC 52 support: shells such as vim/tmux can read and set the clipboard.
  instance.loadAddon(new ClipboardAddon({
    readText: () => navigator.clipboard.readText(),
    writeText: (_selection, text) => { void navigator.clipboard.writeText(text); },
  }));

  instance.open(host.value);
  loadRenderer(rendererKind.value);

  disposables.push(instance.onData(data => { void store.sendTerminal(data, props.terminalId); }));
  disposables.push(instance.onTitleChange(title => emit('title', title)));
  disposables.push(instance.onBell(() => emit('bell')));
  disposables.push(instance.onSelectionChange(() => {
    if (copyOnSelect.value && instance.hasSelection()) void copySelection();
  }));
  disposables.push(instance.onResize(({ cols, rows }) => {
    emit('size', cols, rows);
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { void store.resizeTerminal(props.terminalId, cols, rows); }, 120);
  }));

  instance.attachCustomKeyEventHandler(event => {
    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.shiftKey && event.key.toLowerCase() === 'c') {
      void copySelection(); return false;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'v') {
      void pasteClipboard(); return false;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'f') {
      emit('search'); return false;
    }
    if (mod && event.shiftKey && event.key.toLowerCase() === 'a') {
      selectAll(); return false;
    }
    if (mod && (event.key === '+' || event.key === '=')) { changeFontSize(1); return false; }
    if (mod && event.key === '-') { changeFontSize(-1); return false; }
    if (mod && event.key === '0') { setFontSize(12); return false; }
    // Shift+Insert / Ctrl+Insert are the classic console clipboard bindings.
    if (event.shiftKey && event.key === 'Insert') { void pasteClipboard(); return false; }
    if (event.ctrlKey && event.key === 'Insert') { void copySelection(); return false; }
    return true;
  });

  host.value.addEventListener('contextmenu', onContextMenu);
  resizeObserver = new ResizeObserver(() => scheduleFit());
  resizeObserver.observe(host.value);
  themeObserver = new MutationObserver(() => {
    if (term) term.options.theme = currentTheme();
  });
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });

  unsubscribe = store.subscribeTerminalData(props.terminalId, applyChunk);
  void nextTick(() => { fit(); focus(); });
}

function detach(): void {
  unsubscribe?.();
  unsubscribe = null;
  resizeObserver?.disconnect();
  themeObserver?.disconnect();
  if (writeTimer) clearTimeout(writeTimer);
  if (resizeTimer) clearTimeout(resizeTimer);
  if (fitTimer) clearTimeout(fitTimer);
  flushWrites();
  for (const d of disposables) { try { d.dispose(); } catch { /* already disposed */ } }
  disposables.length = 0;
  try { rendererAddon?.dispose(); } catch { /* already disposed */ }
  rendererAddon = null;
  if (host.value) host.value.removeEventListener('contextmenu', onContextMenu);
  term?.dispose();
  term = null;
  fitAddon = null;
  searchAddon = null;
  serializeAddon = null;
}

onMounted(attach);
onBeforeUnmount(detach);
watch(() => props.terminalId, () => { detach(); void nextTick(attach); });
watch(() => props.active, value => {
  if (value) void nextTick(() => { scheduleFit(); focus(); });
});

defineExpose({
  focus, fit, clear, selectAll, scrollToBottom, copySelection, pasteClipboard,
  findNext, findPrevious, clearSearch, setFontSize, changeFontSize, setRenderer,
  setCopyOnSelect, serialize, serializeText, writeAnsi,
  getFontSize: () => fontSize.value,
  getRenderer: () => rendererKind.value,
  getCopyOnSelect: () => copyOnSelect.value,
});
</script>

<template>
  <div ref="host" class="w-full h-full terminal-host" @click="focus" />
</template>

<style scoped>
.terminal-host {
  background: var(--code-bg);
  padding: 6px 4px 4px 10px;
  overflow: hidden;
}
.terminal-host :deep(.xterm) { height: 100%; }
.terminal-host :deep(.xterm-viewport) {
  background-color: transparent !important;
  scrollbar-width: thin;
}
.terminal-host :deep(.xterm-screen) { text-shadow: none; }
</style>
