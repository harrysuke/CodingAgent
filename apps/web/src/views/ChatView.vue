<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  PanelLeft, PanelRight, FileCode2, X, Sparkles, Bug, BookOpen, TestTube2,
  CircleDot, Copy, Check, Terminal, KeyRound, ArrowRight,
} from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { useAppStore } from '../stores/app';
import { apiFetch, auth } from '../api/client';
import MessageItem from '../components/MessageItem.vue';
import Composer from '../components/Composer.vue';
import RightPanel from '../components/RightPanel.vue';
import TerminalPanel from '../components/TerminalPanel.vue';

const store = useAppStore();
const router = useRouter();
const scroller = ref<HTMLElement | null>(null);
const composer = ref<InstanceType<typeof Composer> | null>(null);
const rightOpen = ref(true);
const fileModal = ref<{ path: string; content: string } | null>(null);
const copied = ref(false);

const suggestions = [
  { icon: Sparkles, label: 'Explain this project', prompt: 'Explore the workspace and explain what this project does, its structure and how the pieces fit together.' },
  { icon: Bug, label: 'Find bugs', prompt: 'Review the code in this workspace for bugs and likely failure modes. List concrete issues with file:line references.' },
  { icon: TestTube2, label: 'Add tests', prompt: 'Find code without test coverage and add tests using the existing test setup. Run them afterwards.' },
  { icon: BookOpen, label: 'Write a README', prompt: 'Write a concise README.md documenting what this project is, how to install and run it, and its main commands.' },
];

const messages = computed(() => store.messages);
const showEmpty = computed(() => !messages.value.length && !store.running);
/** BYOK onboarding: no key and no keyless provider means chat cannot start. */
const needsOwnKey = computed(() => !!auth.user && auth.user.keyCount === 0 && store.usableModels.length === 0);

function scrollToBottom(smooth = false) {
  void nextTick(() => {
    const el = scroller.value;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
  });
}

watch(() => messages.value.map(m => m.parts.map(p => (p.text ?? '').length + JSON.stringify(p.output ?? '').length).reduce((a, b) => a + b, 0)).reduce((a, b) => a + b, 0), () => scrollToBottom());
watch(() => store.running, () => scrollToBottom(true));
onMounted(() => scrollToBottom());

/** Ctrl/Cmd + ` toggles the terminal dock, like a desktop IDE. */
function onGlobalKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === '`') {
    event.preventDefault();
    void store.toggleTerminal();
  }
}
onMounted(() => window.addEventListener('keydown', onGlobalKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onGlobalKeydown));

async function openFile(path: string) {
  try {
    const data = await apiFetch<{ content: string }>(`/api/files/content?path=${encodeURIComponent(path)}`);
    fileModal.value = { path, content: data.content };
  } catch (err) {
    store.error = (err as Error).message;
  }
}

async function copyAll() {
  const text = messages.value
    .map(m => `${m.role === 'user' ? 'You' : 'CodingAgent'}:\n${m.parts.filter(p => p.type === 'text').map(p => p.text).join('\n')}`)
    .join('\n\n---\n\n');
  await navigator.clipboard?.writeText(text);
  copied.value = true;
  setTimeout(() => { copied.value = false; }, 1500);
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0 min-w-0 flex-1">
    <!-- Header -->
    <header class="h-14 shrink-0 flex items-center gap-2 px-3 border-b hairline bg-[var(--surface)] safe-top">
      <button class="p-1.5 rounded-lg hover-soft md:hidden" @click="store.sidebarOpen = true"><PanelLeft :size="17" /></button>
      <button v-if="!store.sidebarOpen" class="p-1.5 rounded-lg hover-soft hidden md:block" title="Show sidebar" @click="store.sidebarOpen = true"><PanelLeft :size="17" /></button>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2 min-w-0">
          <h1 class="text-[13px] font-semibold truncate">{{ store.currentSession?.title ?? 'New session' }}</h1>
          <span v-if="store.running" class="flex items-center gap-1 text-[10px] text-[var(--green)] shrink-0"><CircleDot :size="9" class="pulse-ring" /> working</span>
        </div>
        <div class="text-[10.5px] text-[var(--muted)] truncate">
          {{ store.selectedModel?.displayName ?? 'No model' }}
          <span v-if="store.usage"> · {{ store.usage.totalTokens.toLocaleString() }} tokens</span>
        </div>
      </div>
      <button class="p-1.5 rounded-lg hover-soft" :class="store.terminalOpen ? 'text-[var(--accent-text)]' : 'text-[var(--muted)]'"
        title="Terminal & Agent Skills (Ctrl+`)" @click="store.toggleTerminal()">
        <Terminal :size="16" />
      </button>
      <button class="p-1.5 rounded-lg hover-soft text-[var(--muted)]" title="Copy conversation" @click="copyAll">
        <Check v-if="copied" :size="15" class="text-[var(--green)]" /><Copy v-else :size="15" />
      </button>
      <button class="p-1.5 rounded-lg hover-soft hidden xl:block" :class="rightOpen ? 'text-[var(--accent-text)]' : 'text-[var(--muted)]'" title="Toggle side panel" @click="rightOpen = !rightOpen">
        <PanelRight :size="17" />
      </button>
    </header>

    <!-- Error banner -->
    <div v-if="store.error" class="flex items-start gap-2 px-4 py-2 bg-[var(--red-soft)] text-[var(--red)] text-[12px] border-b border-[var(--red)]/20 shrink-0">
      <span class="flex-1">{{ store.error }}</span>
      <button @click="store.clearError()"><X :size="14" /></button>
    </div>

    <div class="flex flex-1 min-h-0">
      <main class="flex flex-col flex-1 min-w-0 min-h-0">
        <!-- Messages -->
        <div ref="scroller" class="flex-1 overflow-y-auto px-3 sm:px-5">
          <div class="mx-auto w-full max-w-3xl py-4">
            <template v-if="showEmpty">
              <div class="py-10 sm:py-16 text-center fade-up">
                <div class="w-12 h-12 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-text)] grid place-items-center mx-auto mb-4"><FileCode2 :size="24" /></div>
                <h2 class="text-[18px] font-semibold mb-1">What should we build?</h2>
                <p class="text-[12.5px] text-[var(--muted)] mb-7 max-w-sm mx-auto">
                  CodingAgent reads and edits files in your workspace, runs commands and streams every change for review.
                </p>
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 max-w-lg mx-auto text-left">
                  <button v-for="item in suggestions" :key="item.label"
                    class="surface rounded-xl px-3 py-2.5 hover:border-[var(--accent)] transition-colors group"
                    @click="store.send(item.prompt)">
                    <div class="flex items-center gap-2 text-[12px] font-medium"><component :is="item.icon" :size="14" class="text-[var(--accent-text)]" />{{ item.label }}</div>
                    <div class="text-[10.5px] text-[var(--muted)] mt-0.5 line-clamp-2">{{ item.prompt }}</div>
                  </button>
                </div>
              </div>
            </template>

            <template v-else>
              <MessageItem v-for="(message, i) in messages" :key="message.id" :message="message" :streaming="store.running && i === messages.length - 1 && message.role === 'assistant'" />
              <div class="h-2" />
            </template>
          </div>
        </div>

        <!-- BYOK onboarding -->
        <div v-if="needsOwnKey" class="mx-3 sm:mx-5 mb-2 flex items-start gap-3 rounded-xl border border-[var(--amber)]/40 bg-[var(--amber-soft)] px-3.5 py-3 text-[11.5px] text-[var(--amber)]">
          <KeyRound :size="16" class="shrink-0 mt-0.5" />
          <div class="min-w-0 flex-1 leading-relaxed">
            <div class="font-semibold">Add your own API key to start chatting</div>
            <div class="mt-0.5 opacity-90">This account has no provider keys. CodingAgent is bring-your-own-key, so nobody else's quota is used to answer your prompts.</div>
          </div>
          <button class="shrink-0 flex items-center gap-1 rounded-lg border border-[var(--amber)]/40 px-2.5 py-1.5 text-[11px] font-medium hover:bg-[var(--amber)]/10" @click="router.push({ path: '/settings', query: { section: 'providers' } })">
            Add key <ArrowRight :size="12" />
          </button>
        </div>

        <TerminalPanel v-if="store.terminalOpen" @close="store.terminalOpen = false" />
        <Composer ref="composer" />
      </main>

      <RightPanel v-if="rightOpen" @close="rightOpen = false" @open-file="openFile" />
    </div>

    <!-- File viewer -->
    <Teleport to="body">
      <div v-if="fileModal" class="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4" @click.self="fileModal = null">
        <div class="w-full max-w-3xl max-h-[80vh] surface rounded-2xl shadow-[var(--shadow)] flex flex-col overflow-hidden fade-up">
          <div class="flex items-center gap-2 px-4 py-3 border-b hairline shrink-0">
            <FileCode2 :size="15" class="text-[var(--accent-text)]" />
            <span class="text-[12px] font-mono truncate flex-1">{{ fileModal.path }}</span>
            <button class="p-1 rounded hover-soft" @click="fileModal = null"><X :size="15" /></button>
          </div>
          <pre class="flex-1 overflow-auto p-4 text-[11.5px] leading-relaxed font-mono bg-[var(--code-bg)] whitespace-pre">{{ fileModal.content }}</pre>
        </div>
      </div>
    </Teleport>
  </div>
</template>
