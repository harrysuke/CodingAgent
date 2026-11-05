<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import {
  Terminal, X, Eraser, Square, Loader2, Sparkles, PackagePlus, Trash2, Check, AlertTriangle,
  ChevronDown, ChevronRight, Wand2, ShieldCheck, Braces, FolderGit2,
} from 'lucide-vue-next';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const emit = defineEmits<{ (e: 'close'): void }>();

const tab = ref<'terminal' | 'skills'>('terminal');
const command = ref('');
const history = ref<string[]>([]);
const historyIndex = ref(-1);
const scroller = ref<HTMLElement | null>(null);
const input = ref<HTMLInputElement | null>(null);

const skillSource = ref('');
const skillScope = ref<'workspace' | 'user'>('workspace');
const showLog = ref(false);
const installError = ref('');

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g;

interface RenderLine { kind: string; text: string; key: string }

/** Split the chunk stream into display lines so each one can be styled. */
const rendered = computed<RenderLine[]>(() => {
  const lines: RenderLine[] = [];
  let index = 0;
  for (const line of store.terminalLines) {
    const clean = line.data.replace(ANSI, '').replace(/\r/g, '');
    const pieces = clean.split('\n');
    pieces.forEach((piece, position) => {
      // A trailing newline would otherwise render an extra blank row per chunk.
      if (position === pieces.length - 1 && piece === '') return;
      lines.push({
        kind: line.stream,
        text: line.stream === 'input' ? `$ ${piece}` : piece,
        key: `${index++}`,
      });
    });
  }
  return lines.slice(-1200);
});

function scrollDown() {
  void nextTick(() => {
    const el = scroller.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(() => store.terminalLines.length, scrollDown);
watch(() => store.terminalOpen, value => { if (value) scrollDown(); });

function submitCommand() {
  const value = command.value.trim();
  if (!value) return;
  history.value = [...history.value, value].slice(-100);
  historyIndex.value = -1;
  command.value = '';
  void store.sendTerminal(value);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    submitCommand();
    return;
  }
  if (event.key === 'ArrowUp') {
    event.preventDefault();
    if (!history.value.length) return;
    historyIndex.value = historyIndex.value === -1
      ? history.value.length - 1
      : Math.max(0, historyIndex.value - 1);
    command.value = history.value[historyIndex.value] ?? '';
    return;
  }
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    if (historyIndex.value === -1) return;
    historyIndex.value = Math.min(history.value.length - 1, historyIndex.value + 1);
    command.value = history.value[historyIndex.value] ?? '';
    return;
  }
  if (event.key === 'c' && event.ctrlKey) {
    event.preventDefault();
    void store.interruptTerminal();
  }
}

function lineClass(kind: string): string {
  if (kind === 'stderr') return 'text-[var(--red)]';
  if (kind === 'system') return 'text-[var(--faint)] italic';
  if (kind === 'input') return 'text-[var(--accent-text)] font-medium';
  return 'text-[var(--text)]';
}

async function install() {
  const source = skillSource.value.trim();
  if (!source) return;
  installError.value = '';
  store.pushTerminalLine({ stream: 'input', data: `skills install ${source}\n`, at: new Date().toISOString() });
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

async function installBuiltin(name: string) {
  skillSource.value = `builtin:${name}`;
  await install();
}

const skillDirs = computed(() => store.skillDirectories);

function toolSummary(skill: { toolDefaults: Record<string, Record<string, unknown>> }): string {
  const entries = Object.entries(skill.toolDefaults ?? {});
  if (!entries.length) return '';
  return entries.map(([tool, params]) => `${tool}(${Object.entries(params).map(([k, v]) => `${k}=${v}`).join(', ')})`).join(' · ');
}

watch(tab, value => {
  if (value === 'skills') void store.loadSkills();
  if (value === 'terminal') void nextTick(() => input.value?.focus());
});
</script>

<template>
  <section class="shrink-0 border-t hairline bg-[var(--surface-2)] flex flex-col" :style="{ height: '286px' }">
    <!-- Header -->
    <div class="flex items-center gap-1 h-10 px-2 border-b hairline shrink-0">
      <button class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium"
        :class="tab === 'terminal' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--muted)] hover-soft'"
        @click="tab = 'terminal'">
        <Terminal :size="13" /> Terminal
      </button>
      <button class="flex items-center gap-1.5 rounded-md px-2 py-1 text-[11.5px] font-medium"
        :class="tab === 'skills' ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'text-[var(--muted)] hover-soft'"
        @click="tab = 'skills'">
        <Sparkles :size="13" /> Skills
        <span v-if="store.skills.length" class="text-[9.5px] rounded-full bg-[var(--surface-3)] px-1.5">{{ store.skills.length }}</span>
      </button>

      <div class="flex-1" />
      <span v-if="tab === 'terminal'" class="hidden sm:flex items-center gap-1 text-[10px] font-mono text-[var(--faint)] truncate max-w-[280px]">
        <FolderGit2 :size="10" /> {{ store.terminalCwd || store.activeWorkspace?.root || 'workspace' }}
        <span class="uppercase">{{ store.terminalShell }}</span>
      </span>
      <span v-if="tab === 'terminal' && !store.terminalId" class="text-[10px] text-[var(--amber)]">offline</span>
      <button v-if="tab === 'terminal'" class="p-1.5 rounded hover-soft text-[var(--muted)]" title="Interrupt (Ctrl+C)" @click="store.interruptTerminal()"><Square :size="12" /></button>
      <button v-if="tab === 'terminal'" class="p-1.5 rounded hover-soft text-[var(--muted)]" title="Clear" @click="store.clearTerminal()"><Eraser :size="13" /></button>
      <button class="p-1.5 rounded hover-soft text-[var(--muted)]" title="Close panel" @click="emit('close')"><X :size="14" /></button>
    </div>

    <!-- Terminal -->
    <template v-if="tab === 'terminal'">
      <div ref="scroller" class="flex-1 min-h-0 overflow-y-auto px-3 py-2 font-mono text-[11.5px] leading-[1.55] bg-[var(--code-bg)]"
        @click="input?.focus()">
        <div v-if="store.terminalBusy" class="flex items-center gap-2 text-[var(--muted)]"><Loader2 :size="12" class="animate-spin" /> starting shell…</div>
        <div v-if="store.terminalError" class="text-[var(--red)]">{{ store.terminalError }}</div>
        <div v-for="line in rendered" :key="line.key" class="whitespace-pre-wrap break-words" :class="lineClass(line.kind)">{{ line.text }}</div>
        <div v-if="!rendered.length && !store.terminalBusy" class="text-[var(--faint)]">
          A persistent shell in the workspace root. Run builds, git, package managers — or install skills from the Skills tab.
        </div>
      </div>
      <div class="flex items-center gap-2 px-3 h-10 border-t hairline shrink-0 bg-[var(--surface)]">
        <span class="text-[12px] font-mono text-[var(--accent-text)] shrink-0">$</span>
        <input ref="input" v-model="command" spellcheck="false" autocomplete="off"
          placeholder="Type a command and press Enter (↑ for history)"
          class="flex-1 min-w-0 bg-transparent text-[12px] font-mono outline-none placeholder:text-[var(--faint)]"
          @keydown="onKeydown" />
        <button class="rounded-md bg-[var(--accent)] text-white px-2.5 py-1 text-[11px] font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40"
          :disabled="!command.trim()" @click="submitCommand">Run</button>
      </div>
    </template>

    <!-- Skills -->
    <template v-else>
      <div class="flex-1 min-h-0 overflow-y-auto px-3 py-2.5 space-y-3">
        <!-- Install -->
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

        <!-- Installed -->
        <div v-if="!store.skills.length" class="text-center text-[11px] text-[var(--faint)] py-4">
          No skills installed. A skill adds standing instructions and tool defaults to every turn in this workspace.
        </div>
        <div v-else class="space-y-1.5">
          <div v-for="skill in store.skills" :key="skill.id"
            class="rounded-xl border hairline bg-[var(--surface)] px-2.5 py-2">
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

        <!-- Install log -->
        <div v-if="store.skillsLog.length">
          <button class="flex items-center gap-1 text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]" @click="showLog = !showLog">
            <ChevronDown v-if="showLog" :size="10" /><ChevronRight v-else :size="10" /> Install log
          </button>
          <pre v-if="showLog" class="mt-1 max-h-32 overflow-auto rounded-lg bg-[var(--code-bg)] border hairline p-2 text-[10px] font-mono whitespace-pre-wrap">{{ store.skillsLog.join('\n') }}</pre>
        </div>
      </div>
    </template>
  </section>
</template>
