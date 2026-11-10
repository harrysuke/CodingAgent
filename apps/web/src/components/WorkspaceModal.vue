<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  X, FolderOpen, ChevronRight, CornerLeftUp, GitBranch, HardDrive, Loader2, Check,
  FolderSearch, ShieldCheck, Clock, Files, AlertTriangle, CircleCheck,
} from 'lucide-vue-next';
import type { BrowseResult } from '@codingagent/shared';
import { useAppStore, type WorkspacePickerMode } from '../stores/app';

const props = defineProps<{ open: boolean; mode: WorkspacePickerMode }>();
const emit = defineEmits<{ (e: 'close'): void }>();
const store = useAppStore();

/** `new-session` claims the folder for a fresh, independent workspace. */
const isNewSession = computed(() => props.mode === 'new-session');

const browse = ref<BrowseResult | null>(null);
const loading = ref(false);
const failure = ref('');
const manualPath = ref('');

/** Same folder, regardless of drive-letter case or slash direction. */
function normalize(value: string | undefined): string {
  return (value ?? '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
}

const currentRoot = computed(() => normalize(store.activeWorkspace?.root));
/** The folder that the primary button would actually use. */
const target = computed(() => (manualPath.value || browse.value?.path || '').trim());
/** A new session may reuse the current folder; it still gets its own binding. */
const isCurrent = computed(() => !isNewSession.value && !!target.value && normalize(target.value) === currentRoot.value);

function isCurrentEntry(path: string): boolean {
  return !!path && normalize(path) === currentRoot.value;
}

const crumbs = computed(() => {
  const current = browse.value?.path ?? '';
  if (!current) return [];
  const sep = browse.value?.separator ?? '/';
  const parts = current.split(/[\\/]+/).filter(Boolean);
  const out: Array<{ label: string; path: string }> = [];
  let acc = '';
  parts.forEach((part, index) => {
    if (index === 0) acc = part.endsWith(':') ? `${part}${sep}` : `${sep}${part}`;
    else acc = `${acc.replace(/[\\/]+$/, '')}${sep}${part}`;
    out.push({ label: part, path: acc });
  });
  return out;
});

const recent = computed(() => store.workspace?.recent ?? []);

async function go(target?: string) {
  loading.value = true;
  failure.value = '';
  try {
    browse.value = await store.browseWorkspace(target);
    manualPath.value = browse.value.path;
  } catch (err) {
    failure.value = (err as Error).message;
  } finally {
    loading.value = false;
  }
}

async function openCurrent() {
  const folder = target.value;
  if (!folder) return;
  failure.value = '';
  try {
    await store.chooseWorkspaceFolder(folder, props.mode);
    emit('close');
  } catch (err) {
    failure.value = (err as Error).message;
  }
}

/** Shortcut: start a new session in the folder the current session already uses. */
async function useCurrentFolder() {
  failure.value = '';
  try {
    await store.createSessionInCurrentFolder();
    emit('close');
  } catch (err) {
    failure.value = (err as Error).message;
  }
}

function goManual() {
  const target = manualPath.value.trim();
  if (target) void go(target);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) emit('close');
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));

watch(() => props.open, value => {
  if (!value) return;
  failure.value = '';
  // A new session starts at the account's default root so browsing to a
  // different project folder is the natural action. Changing the folder of
  // the current session starts where that session already is.
  const start = isNewSession.value
    ? (store.workspace?.defaultRoot || store.activeWorkspace?.root)
    : (store.activeWorkspace?.root || store.workspace?.defaultRoot);
  void go(start);
}, { immediate: true });
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-3 sm:p-6" @click.self="emit('close')">
      <div class="w-full max-w-3xl max-h-[88vh] surface rounded-2xl shadow-[var(--shadow)] flex flex-col overflow-hidden fade-up">
        <!-- Header -->
        <div class="flex items-center gap-2.5 px-4 py-3 border-b hairline shrink-0">
          <div class="w-8 h-8 rounded-lg bg-[var(--accent-soft)] text-[var(--accent-text)] grid place-items-center"><FolderOpen :size="16" /></div>
          <div class="min-w-0 flex-1">
            <h2 class="text-[13.5px] font-semibold leading-tight">{{ isNewSession ? 'Start a new session' : 'Open a workspace' }}</h2>
            <p class="text-[10.5px] text-[var(--muted)] leading-tight truncate">
              {{ isNewSession ? 'Choose the project folder for this session' : 'The folder the agent may read, edit and run commands in' }}
            </p>
          </div>
          <button class="p-1.5 rounded-lg hover-soft text-[var(--muted)]" @click="emit('close')"><X :size="16" /></button>
        </div>

        <!-- Stale server build: the folder API simply is not there yet -->
        <div v-if="store.workspaceStale"
          class="mx-3 mt-3 flex items-start gap-2 rounded-xl border border-[var(--amber)]/35 bg-[var(--amber-soft)] px-3 py-2 text-[11px] text-[var(--amber)] shrink-0">
          <AlertTriangle :size="13" class="shrink-0 mt-0.5" />
          <span class="leading-snug">
            The agent server is running an <strong>older build</strong> that has no workspace API.
            Stop it, run <code class="font-mono font-semibold">npm start</code> again, then reload this page.
          </span>
        </div>

        <!-- Each session keeps its own folder -->
        <div v-if="isNewSession"
          class="mx-3 mt-3 flex items-start gap-2 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)] px-3 py-2 text-[11px] text-[var(--accent-text)] shrink-0">
          <ShieldCheck :size="13" class="shrink-0 mt-0.5" />
          <span class="leading-snug">Each session has its own project folder. The folder you pick here belongs to the new session only — other sessions keep theirs.</span>
        </div>

        <!-- Current workspace -->
        <div v-if="store.activeWorkspace" class="mx-3 mt-3 rounded-xl border hairline bg-[var(--surface-2)] px-3 py-2 shrink-0">
          <div class="text-[9.5px] uppercase tracking-wider font-semibold text-[var(--faint)] mb-1">
            {{ isNewSession ? 'Current session is using' : 'Current workspace' }}
          </div>
          <div class="flex items-center gap-2 text-[11px] text-[var(--muted)]">
            <ShieldCheck :size="12" class="text-[var(--green)] shrink-0" />
            <span class="font-medium text-[var(--text)] truncate">{{ store.activeWorkspace.project.name }}</span>
            <span class="flex items-center gap-1 shrink-0" v-if="store.activeWorkspace.isGit">
              <GitBranch :size="11" />{{ store.activeWorkspace.branch ?? 'git' }}
            </span>
            <span class="flex items-center gap-1 shrink-0"><Files :size="11" />{{ store.activeWorkspace.fileCount }}</span>
          </div>
          <div class="text-[10.5px] font-mono text-[var(--faint)] truncate mt-0.5">{{ store.activeWorkspace.root }}</div>
        </div>

        <!-- Path bar -->
        <div class="px-3 pt-3 shrink-0">
          <div class="flex items-center gap-1.5">
            <div class="relative flex-1 min-w-0">
              <FolderSearch :size="13" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
              <input v-model="manualPath" spellcheck="false" placeholder="Paste an absolute folder path…"
                class="w-full bg-[var(--surface-3)] rounded-lg pl-8 pr-2 py-1.5 text-[11.5px] font-mono outline-none focus:ring-2 focus:ring-[var(--accent)]"
                @keydown.enter.prevent="goManual" />
            </div>
            <button class="rounded-lg border hairline bg-[var(--surface)] px-2.5 py-1.5 text-[11.5px] font-medium hover-soft" @click="goManual">Go</button>
          </div>

          <!-- Breadcrumbs -->
          <div class="flex items-center gap-0.5 flex-wrap mt-2 text-[10.5px] min-h-[18px]">
            <button v-for="(crumb, i) in crumbs" :key="crumb.path"
              class="flex items-center gap-0.5 rounded px-1 py-0.5 hover-soft text-[var(--muted)] hover:text-[var(--text)]"
              @click="go(crumb.path)">
              <ChevronRight v-if="i > 0" :size="10" class="text-[var(--faint)]" />
              <span :class="i === crumbs.length - 1 ? 'font-medium text-[var(--text)]' : ''">{{ crumb.label }}</span>
            </button>
          </div>

          <!-- Roots -->
          <div class="flex items-center gap-1 flex-wrap mt-1.5">
            <button v-for="root in browse?.roots ?? []" :key="root.path"
              class="flex items-center gap-1 rounded-md border hairline bg-[var(--surface)] px-1.5 py-0.5 text-[10.5px] hover-soft"
              @click="go(root.path)">
              <HardDrive :size="10" class="text-[var(--faint)]" />{{ root.name }}
            </button>
          </div>
        </div>

        <!-- Directory list -->
        <div class="flex-1 min-h-[180px] overflow-y-auto px-3 py-2 mt-1">
          <div v-if="loading" class="flex items-center justify-center gap-2 py-10 text-[12px] text-[var(--muted)]">
            <Loader2 :size="14" class="animate-spin" /> Reading folders…
          </div>
          <div v-else-if="failure" class="flex items-start gap-2 rounded-lg border border-[var(--red)]/25 bg-[var(--red-soft)] px-3 py-2 text-[11.5px] text-[var(--red)]">
            <AlertTriangle :size="13" class="shrink-0 mt-0.5" />{{ failure }}
          </div>
          <template v-else>
            <button v-if="browse?.parent" class="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11.5px] text-[var(--muted)] hover-soft"
              @click="go(browse?.parent ?? undefined)">
              <CornerLeftUp :size="13" /> <span class="font-mono">..</span>
            </button>
            <button v-for="entry in browse?.entries ?? []" :key="entry.path"
              class="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-[11.5px] text-left hover-soft"
              :class="isCurrentEntry(entry.path) ? 'bg-[var(--accent-soft)]' : ''"
              @click="go(entry.path)">
              <FolderOpen :size="13" class="text-[var(--amber)] shrink-0" />
              <span class="truncate flex-1">{{ entry.name }}</span>
              <span v-if="isCurrentEntry(entry.path)" class="flex items-center gap-0.5 text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--surface)] text-[var(--green)] shrink-0">
                <CircleCheck :size="9" /> current
              </span>
              <span v-if="entry.isGit" class="flex items-center gap-1 text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent-text)] shrink-0">
                <GitBranch :size="9" /> repo
              </span>
              <ChevronRight v-if="entry.hasChildren" :size="12" class="text-[var(--faint)] shrink-0" />
            </button>
            <div v-if="!browse?.entries.length" class="py-8 text-center text-[11.5px] text-[var(--faint)]">No sub-folders here.</div>
          </template>
        </div>

        <!-- Recent -->
        <div v-if="recent.length" class="px-3 pb-1 shrink-0">
          <div class="flex items-center gap-1.5 text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)] mb-1">
            <Clock :size="10" /> Recent workspaces
          </div>
          <div class="flex gap-1.5 overflow-x-auto pb-1">
            <button v-for="item in recent" :key="item.project.id"
              class="shrink-0 max-w-[220px] text-left rounded-lg border hairline bg-[var(--surface)] px-2 py-1.5 hover:border-[var(--accent)]"
              @click="go(item.root)">
              <div class="text-[11px] font-medium truncate">{{ item.project.name }}</div>
              <div class="text-[9.5px] font-mono text-[var(--faint)] truncate">{{ item.root }}</div>
            </button>
          </div>
        </div>

        <!-- Footer -->
        <div class="flex items-center gap-2 flex-wrap px-3 py-3 border-t hairline shrink-0">
          <p class="flex-1 min-w-[140px] text-[10.5px] text-[var(--muted)] leading-snug">
            {{ isNewSession
              ? 'The new session will be sandboxed to this folder. Paths outside it — including through symlinks — are refused.'
              : 'The agent is sandboxed to this folder. Paths outside it — including through symlinks — are refused.' }}
          </p>
          <button v-if="isNewSession"
            class="rounded-lg border hairline bg-[var(--surface)] px-3 py-1.5 text-[11.5px] font-medium hover-soft disabled:opacity-50"
            :disabled="store.workspaceBusy || !currentRoot" @click="useCurrentFolder">
            Use current folder
          </button>
          <button class="rounded-lg border hairline bg-[var(--surface)] px-3 py-1.5 text-[11.5px] font-medium hover-soft" @click="emit('close')">Cancel</button>
          <button v-if="isCurrent" disabled
            class="flex items-center gap-1.5 rounded-lg bg-[var(--surface-3)] text-[var(--faint)] px-3 py-1.5 text-[11.5px] font-medium">
            <CircleCheck :size="12" /> Already open
          </button>
          <button v-else
            class="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] text-white px-3 py-1.5 text-[11.5px] font-medium hover:bg-[var(--accent-hover)] disabled:opacity-50"
            :disabled="store.workspaceBusy || !target" @click="openCurrent">
            <Loader2 v-if="store.workspaceBusy" :size="12" class="animate-spin" /><Check v-else :size="12" />
            {{ isNewSession ? 'Create session here' : 'Open this folder' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
