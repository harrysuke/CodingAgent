<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  ArrowLeft, Server, Database, KeyRound, SlidersHorizontal, BarChart3, Plus, Trash2,
  ShieldCheck, Check, Loader2, RefreshCw, Info, Cpu, AlertTriangle, UserRound, LogOut, LockKeyhole,
} from 'lucide-vue-next';
import { PLATFORMS, type Platform } from '@codingagent/shared';
import { useAppStore } from '../stores/app';
import { auth, changePasswordRequest, connection } from '../api/client';

const store = useAppStore();
const router = useRouter();
const route = useRoute();

type Section = 'account' | 'connection' | 'model' | 'providers' | 'analytics' | 'about';
const section = ref<Section>('account');
const sections = [
  { value: 'account', label: 'Account', icon: UserRound },
  { value: 'connection', label: 'Connection', icon: Server },
  { value: 'model', label: 'Agent', icon: SlidersHorizontal },
  { value: 'providers', label: 'Providers & keys', icon: KeyRound },
  { value: 'analytics', label: 'Usage', icon: BarChart3 },
  { value: 'about', label: 'About', icon: Info },
] as const;

const urlInput = ref(connection.url);
// initConnection() can repair a stale sidecar URL after this view was created.
watch(() => connection.url, value => { urlInput.value = value; });
const passwordDraft = reactive({ current: '', next: '', confirm: '' });
const passwordBusy = ref(false);
const passwordMessage = ref<{ ok: boolean; text: string } | null>(null);
const testing = ref(false);
const testResult = ref<{ ok: boolean; message: string } | null>(null);

const draft = reactive({
  defaultPlatform: '', defaultModelId: '', permissionMode: 'ask', agent: 'build',
  maxSteps: 30, systemPromptSuffix: '',
});

const newKey = reactive({ platform: 'custom', key: '', label: '', baseUrl: '' });
const adding = ref(false);
const keyError = ref('');
const saving = ref(false);
const saved = ref(false);

const modelsForPlatform = computed(() => store.models.filter(m => m.platform === draft.defaultPlatform));
const groupedKeys = computed(() => store.keys);

onMounted(() => {
  if (route.query.section === 'providers') section.value = 'providers';
  Object.assign(draft, {
    defaultPlatform: store.settings.defaultPlatform ?? '',
    defaultModelId: store.settings.defaultModelId ?? '',
    permissionMode: store.settings.permissionMode,
    agent: store.settings.agent,
    maxSteps: store.settings.maxSteps,
    systemPromptSuffix: store.settings.systemPromptSuffix,
  });
  void store.loadAnalytics();
});

async function testConnection() {
  testing.value = true;
  testResult.value = null;
  const ok = await store.applyConnection(urlInput.value);
  testResult.value = ok
    ? { ok: true, message: `Connected · ${connection.health?.models ?? 0} models. Sign in again to use this server.` }
    : { ok: false, message: connection.error || 'Could not reach the server' };
  testing.value = false;
}

async function changePassword() {
  passwordMessage.value = null;
  if (passwordDraft.next.length < 8) { passwordMessage.value = { ok: false, text: 'Use at least 8 characters.' }; return; }
  if (passwordDraft.next !== passwordDraft.confirm) { passwordMessage.value = { ok: false, text: 'New passwords do not match.' }; return; }
  passwordBusy.value = true;
  try {
    await changePasswordRequest(passwordDraft.current, passwordDraft.next);
    passwordDraft.current = ''; passwordDraft.next = ''; passwordDraft.confirm = '';
    passwordMessage.value = { ok: true, text: 'Password changed. All sessions were signed out — please sign in again.' };
  } catch (err) { passwordMessage.value = { ok: false, text: (err as Error).message }; }
  finally { passwordBusy.value = false; }
}

async function signOut() {
  await store.signOut();
  router.push('/');
}

async function save() {
  saving.value = true;
  await store.saveSettings({
    defaultPlatform: (draft.defaultPlatform || null) as Platform | null,
    defaultModelId: draft.defaultModelId || null,
    permissionMode: draft.permissionMode as 'ask' | 'allow' | 'deny',
    agent: draft.agent as 'build' | 'plan' | 'general',
    maxSteps: Number(draft.maxSteps),
    systemPromptSuffix: draft.systemPromptSuffix,
  });
  saving.value = false;
  saved.value = true;
  setTimeout(() => { saved.value = false; }, 1800);
}

async function addKey() {
  keyError.value = '';
  if (!newKey.key.trim()) { keyError.value = 'API key is required'; return; }
  adding.value = true;
  try {
    await store.addKey({
      platform: newKey.platform, key: newKey.key.trim(), label: newKey.label.trim() || undefined,
      baseUrl: newKey.baseUrl.trim() || undefined,
    });
    newKey.key = ''; newKey.label = ''; newKey.baseUrl = '';
  } catch (err) { keyError.value = (err as Error).message; }
  finally { adding.value = false; }
}

function selectSection(value: Section) {
  section.value = value;
  if (value === 'analytics') void store.loadAnalytics();
}
</script>

<template>
  <div class="flex flex-col h-full min-h-0 flex-1">
    <header class="h-14 shrink-0 flex items-center gap-3 px-3 border-b hairline bg-[var(--surface)] safe-top">
      <button class="p-1.5 rounded-lg hover-soft" @click="router.push('/')"><ArrowLeft :size="17" /></button>
      <h1 class="text-[13px] font-semibold">Settings</h1>
      <span class="ml-auto text-[11px] text-[var(--muted)] hidden sm:block">v0.1.0</span>
    </header>

    <div class="flex flex-1 min-h-0 flex-col md:flex-row">
      <!-- Section nav -->
      <nav class="flex md:flex-col gap-1 overflow-x-auto md:overflow-visible md:w-52 shrink-0 border-b md:border-b-0 md:border-r hairline p-2 md:p-3 bg-[var(--surface-2)]">
        <button v-for="item in sections" :key="item.value"
          class="flex items-center gap-2 rounded-lg px-3 py-2 text-[12px] font-medium whitespace-nowrap md:w-full text-left"
          :class="section === item.value ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'hover-soft text-[var(--muted)]'"
          @click="selectSection(item.value)">
          <component :is="item.icon" :size="14" /> {{ item.label }}
        </button>
      </nav>

      <div class="flex-1 overflow-y-auto p-4 sm:p-6">
        <div class="max-w-2xl mx-auto space-y-5">

          <!-- Account -->
          <template v-if="section === 'account'">
            <div><h2 class="text-[15px] font-semibold">Account</h2><p class="text-[12px] text-[var(--muted)] mt-0.5">Your identity, keys and session on this server.</p></div>
            <div class="surface rounded-xl p-4 space-y-3">
              <div class="flex items-center gap-3">
                <div class="w-10 h-10 rounded-xl bg-[var(--accent-soft)] text-[var(--accent-text)] grid place-items-center text-[15px] font-semibold uppercase shrink-0">
                  {{ (auth.user?.name || auth.user?.email || '?').slice(0, 1) }}
                </div>
                <div class="min-w-0">
                  <div class="text-[13px] font-medium truncate">{{ auth.user?.name || 'Unnamed account' }}</div>
                  <div class="text-[11.5px] text-[var(--muted)] truncate">{{ auth.user?.email }}</div>
                </div>
                <span class="ml-auto text-[10px] px-2 py-1 rounded-md border hairline shrink-0"
                  :class="auth.user?.isAdmin ? 'text-[var(--accent-text)]' : 'text-[var(--muted)]'">
                  {{ auth.user?.isAdmin ? 'Administrator' : 'Member' }}
                </span>
              </div>
              <div class="grid grid-cols-2 gap-2 border-t hairline pt-3">
                <div class="rounded-lg bg-[var(--surface-2)] p-3">
                  <div class="text-[10.5px] text-[var(--muted)]">Provider keys (yours only)</div>
                  <div class="text-[18px] font-semibold mt-0.5" :class="auth.user?.keyCount ? 'text-[var(--green)]' : 'text-[var(--amber)]'">{{ auth.user?.keyCount ?? 0 }}</div>
                </div>
                <div class="rounded-lg bg-[var(--surface-2)] p-3">
                  <div class="text-[10.5px] text-[var(--muted)]">Registration</div>
                  <div class="text-[12px] font-medium mt-1.5">{{ auth.status?.registrationOpen ? 'Open' : 'Closed' }}</div>
                </div>
              </div>
              <div class="flex items-start gap-2 text-[11px] leading-relaxed text-[var(--muted)] bg-[var(--green-soft)] text-[var(--green)] rounded-lg px-3 py-2">
                <ShieldCheck :size="14" class="shrink-0 mt-0.5" />
                <span>Keys, sessions, settings, workspaces and usage are isolated per account. Other registered users cannot see or spend your keys — they must add their own.</span>
              </div>
              <button class="w-full flex items-center justify-center gap-2 rounded-lg border hairline px-3 py-2 text-[12px] font-medium hover-soft" @click="signOut">
                <LogOut :size="13" /> Sign out
              </button>
            </div>

            <div class="surface rounded-xl p-4">
              <h3 class="text-[12.5px] font-semibold mb-3 flex items-center gap-1.5"><LockKeyhole :size="14" /> Change password</h3>
              <div class="grid gap-3 sm:grid-cols-3">
                <label class="block"><span class="text-[11px] font-medium text-[var(--muted)]">Current</span>
                  <input v-model="passwordDraft.current" type="password" autocomplete="current-password" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]" /></label>
                <label class="block"><span class="text-[11px] font-medium text-[var(--muted)]">New</span>
                  <input v-model="passwordDraft.next" type="password" autocomplete="new-password" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]" /></label>
                <label class="block"><span class="text-[11px] font-medium text-[var(--muted)]">Confirm</span>
                  <input v-model="passwordDraft.confirm" type="password" autocomplete="new-password" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]" /></label>
              </div>
              <div v-if="passwordMessage" class="mt-2 text-[11.5px] rounded-lg px-3 py-2"
                :class="passwordMessage.ok ? 'bg-[var(--green-soft)] text-[var(--green)]' : 'bg-[var(--red-soft)] text-[var(--red)]'">{{ passwordMessage.text }}</div>
              <button class="mt-3 rounded-lg bg-[var(--accent)] text-white px-3.5 py-2 text-[12px] font-medium disabled:opacity-60" :disabled="passwordBusy" @click="changePassword">
                <Loader2 v-if="passwordBusy" :size="13" class="inline animate-spin" /> {{ passwordBusy ? 'Saving…' : 'Update password' }}
              </button>
              <p class="mt-2 text-[10.5px] text-[var(--faint)]">Changing your password signs out every device. You will need to sign in again.</p>
            </div>
          </template>

          <!-- Connection -->
          <template v-else-if="section === 'connection'">
            <div>
              <h2 class="text-[15px] font-semibold">Connection</h2>
              <p class="text-[12px] text-[var(--muted)] mt-0.5">Desktop starts the agent server automatically. Mobile connects to a server on your machine or LAN.</p>
            </div>
            <div class="surface rounded-xl p-4 space-y-4">
              <label class="block">
                <span class="text-[11px] font-medium text-[var(--muted)]">Server URL</span>
                <input v-model="urlInput" placeholder="http://192.168.1.50:4317 (empty = same origin)"
                  class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] font-mono outline-none focus:border-[var(--accent)]" />
              </label>
              <div class="flex items-center gap-2 flex-wrap">
                <button class="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] text-white px-3.5 py-2 text-[12px] font-medium disabled:opacity-60" :disabled="testing" @click="testConnection">
                  <Loader2 v-if="testing" :size="13" class="animate-spin" /><Check v-else :size="13" /> Save & test
                </button>
                <span class="text-[11px]" :class="connection.connected ? 'text-[var(--green)]' : 'text-[var(--red)]'">
                  {{ connection.connected ? '● Connected' : '● Offline' }}
                </span>
              </div>
              <div v-if="testResult" class="text-[11.5px] rounded-lg px-3 py-2"
                :class="testResult.ok ? 'bg-[var(--green-soft)] text-[var(--green)]' : 'bg-[var(--red-soft)] text-[var(--red)]'">
                {{ testResult.message }}
              </div>
              <div class="text-[11px] text-[var(--muted)] border-t hairline pt-3 space-y-1">
                <div>Mode: <code class="font-mono">{{ connection.mode }}</code></div>
                <div>Current session folder: <code class="font-mono break-all">{{ store.activeWorkspace?.root ?? connection.health?.workspaceRoot ?? '—' }}</code></div>
                <div>Signed in as: <code class="font-mono">{{ auth.user?.email ?? '—' }}</code></div>
              </div>
              <div class="flex items-start gap-2 text-[11px] leading-relaxed rounded-lg bg-[var(--amber-soft)] text-[var(--amber)] px-3 py-2">
                <AlertTriangle :size="13" class="shrink-0 mt-0.5" />
                <span>There is no shared access token anymore. Each account signs in with its own email and password, and the session token is stored only in this browser. Changing the server URL signs you out.</span>
              </div>
            </div>
          </template>

          <!-- Agent settings -->
          <template v-else-if="section === 'model'">
            <div><h2 class="text-[15px] font-semibold">Agent defaults</h2><p class="text-[12px] text-[var(--muted)] mt-0.5">Applied to new sessions. You can override the model per session.</p></div>
            <div class="surface rounded-xl p-4 space-y-4">
              <div class="grid gap-3 sm:grid-cols-2">
                <label class="block">
                  <span class="text-[11px] font-medium text-[var(--muted)]">Provider</span>
                  <select v-model="draft.defaultPlatform" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]">
                    <option value="">Auto</option>
                    <option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
                  </select>
                </label>
                <label class="block">
                  <span class="text-[11px] font-medium text-[var(--muted)]">Model</span>
                  <select v-model="draft.defaultModelId" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]">
                    <option value="">Auto (best tool-capable)</option>
                    <option v-for="m in modelsForPlatform" :key="m.id" :value="m.modelId">{{ m.displayName }}{{ m.supportsTools ? '' : ' (no tools)' }}</option>
                  </select>
                </label>
                <label class="block">
                  <span class="text-[11px] font-medium text-[var(--muted)]">Permission mode</span>
                  <select v-model="draft.permissionMode" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]">
                    <option value="ask">Ask for write / edit / bash</option>
                    <option value="allow">Allow all</option>
                    <option value="deny">Read-only</option>
                  </select>
                </label>
                <label class="block">
                  <span class="text-[11px] font-medium text-[var(--muted)]">Default agent</span>
                  <select v-model="draft.agent" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]">
                    <option value="build">Build</option><option value="plan">Plan (read-only)</option><option value="general">General</option>
                  </select>
                </label>
                <label class="block">
                  <span class="text-[11px] font-medium text-[var(--muted)]">Max agent steps</span>
                  <input v-model.number="draft.maxSteps" type="number" min="1" max="100"
                    class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]" />
                </label>
              </div>
              <label class="block">
                <span class="text-[11px] font-medium text-[var(--muted)]">Extra system instructions</span>
                <textarea v-model="draft.systemPromptSuffix" rows="3" placeholder="e.g. Always use TypeScript strict mode; run npm test before finishing."
                  class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)] resize-y" />
              </label>
              <div class="flex items-center gap-2">
                <button class="rounded-lg bg-[var(--accent)] text-white px-3.5 py-2 text-[12px] font-medium" :disabled="saving" @click="save">
                  {{ saving ? 'Saving…' : 'Save settings' }}
                </button>
                <span v-if="saved" class="text-[11.5px] text-[var(--green)] flex items-center gap-1"><Check :size="13" /> Saved</span>
              </div>
              <div class="flex items-start gap-2 text-[11px] text-[var(--muted)] bg-[var(--amber-soft)] text-[var(--amber)] rounded-lg px-3 py-2">
                <ShieldCheck :size="13" class="shrink-0 mt-0.5" />
                <span>Shell commands are sandboxed to the workspace and a destructive-command blocklist is always enforced, even in Allow-all mode.</span>
              </div>
            </div>
          </template>

          <!-- Providers -->
          <template v-else-if="section === 'providers'">
            <div>
              <h2 class="text-[15px] font-semibold">Providers & API keys</h2>
              <p class="text-[12px] text-[var(--muted)] mt-0.5">These {{ store.keys.length }} encrypted key{{ store.keys.length === 1 ? '' : 's' }} belong only to <strong>{{ auth.user?.email }}</strong>. Other accounts cannot see or use them.</p>
            </div>

            <div v-if="!store.keys.length" class="flex items-start gap-2.5 rounded-xl border border-[var(--amber)]/40 bg-[var(--amber-soft)] p-3.5 text-[11.5px] leading-relaxed text-[var(--amber)]">
              <KeyRound :size="16" class="shrink-0 mt-0.5" />
              <div>
                <div class="font-semibold mb-0.5">Bring your own key to start chatting</div>
                New accounts intentionally start with zero keys so nobody can spend the owner's quota. Add a provider key below — it is encrypted with AES-256-GCM and scoped to your account. A default model is selected automatically from your first key.
              </div>
            </div>

            <div class="surface rounded-xl divide-y hairline">
              <div v-for="key in groupedKeys" :key="key.id" class="flex items-center gap-3 px-3.5 py-2.5">
                <div class="w-8 h-8 rounded-lg bg-[var(--surface-3)] grid place-items-center shrink-0"><KeyRound :size="14" class="text-[var(--muted)]" /></div>
                <div class="min-w-0 flex-1">
                  <div class="text-[12px] font-medium flex items-center gap-1.5 flex-wrap">
                    {{ key.platform }}
                    <span v-if="key.label" class="text-[10px] text-[var(--faint)] font-normal">{{ key.label }}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded" :class="key.status === 'healthy' ? 'bg-[var(--green-soft)] text-[var(--green)]' : 'bg-[var(--amber-soft)] text-[var(--amber)]'">{{ key.status }}</span>
                  </div>
                  <div class="text-[10.5px] font-mono text-[var(--muted)] truncate">{{ key.maskedKey }}<span v-if="key.baseUrl"> · {{ key.baseUrl }}</span></div>
                </div>
                <button class="text-[10.5px] px-2 py-1 rounded-md border hairline hover-soft" :class="key.enabled ? 'text-[var(--green)]' : 'text-[var(--faint)]'" @click="store.toggleKey(key.id, !key.enabled)">
                  {{ key.enabled ? 'Enabled' : 'Disabled' }}
                </button>
                <button class="p-1.5 rounded hover:bg-[var(--red-soft)] text-[var(--red)]" title="Remove" @click="store.removeKey(key.id)"><Trash2 :size="13" /></button>
              </div>
              <div v-if="!groupedKeys.length" class="p-5 text-center text-[12px] text-[var(--muted)]">No keys on this account yet. Add your own below.</div>
            </div>

            <div class="surface rounded-xl p-4">
              <h3 class="text-[12.5px] font-semibold mb-3 flex items-center gap-1.5"><Plus :size="14" /> Add provider key</h3>
              <div class="grid gap-3 sm:grid-cols-2">
                <label class="block"><span class="text-[11px] font-medium text-[var(--muted)]">Platform</span>
                  <select v-model="newKey.platform" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none">
                    <option v-for="p in PLATFORMS" :key="p" :value="p">{{ p }}</option>
                  </select>
                </label>
                <label class="block"><span class="text-[11px] font-medium text-[var(--muted)]">Label</span>
                  <input v-model="newKey.label" placeholder="optional" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none" />
                </label>
                <label class="block sm:col-span-2"><span class="text-[11px] font-medium text-[var(--muted)]">API key</span>
                  <input v-model="newKey.key" type="password" placeholder="sk-…" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] font-mono outline-none" />
                </label>
                <label v-if="newKey.platform === 'custom'" class="block sm:col-span-2"><span class="text-[11px] font-medium text-[var(--muted)]">Base URL (OpenAI-compatible)</span>
                  <input v-model="newKey.baseUrl" placeholder="http://localhost:11434/v1" class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] font-mono outline-none" />
                </label>
              </div>
              <div v-if="keyError" class="mt-2 text-[11px] text-[var(--red)]">{{ keyError }}</div>
              <button class="mt-3 rounded-lg bg-[var(--accent)] text-white px-3.5 py-2 text-[12px] font-medium" :disabled="adding" @click="addKey">
                <Loader2 v-if="adding" :size="13" class="inline animate-spin" /> {{ adding ? 'Adding…' : 'Add key' }}
              </button>
            </div>

            <div class="surface rounded-xl p-4">
              <h3 class="text-[12.5px] font-semibold mb-2 flex items-center gap-1.5"><Cpu :size="14" /> Provider status</h3>
              <div class="flex flex-wrap gap-1.5">
                <span v-for="p in store.providers" :key="p.platform"
                  class="text-[10.5px] px-2 py-1 rounded-md border hairline"
                  :class="p.configured ? 'text-[var(--green)] border-[var(--green)]/30' : 'text-[var(--faint)]'">
                  {{ p.platform }} · {{ p.modelCount }} <span v-if="!p.configured">(no key)</span>
                </span>
              </div>
            </div>
          </template>

          <!-- Analytics -->
          <template v-else-if="section === 'analytics'">
            <div class="flex items-center justify-between">
              <div><h2 class="text-[15px] font-semibold">Usage</h2><p class="text-[12px] text-[var(--muted)] mt-0.5">Telemetry is written to the reused <code class="font-mono">requests</code> table.</p></div>
              <button class="p-2 rounded-lg border hairline hover-soft" @click="store.loadAnalytics()"><RefreshCw :size="14" /></button>
            </div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-2">
              <div v-for="card in [
                { label: 'Requests', value: store.analytics?.requests ?? 0 },
                { label: 'Input tokens', value: (store.analytics?.inputTokens ?? 0).toLocaleString() },
                { label: 'Output tokens', value: (store.analytics?.outputTokens ?? 0).toLocaleString() },
                { label: 'Avg latency', value: `${store.analytics?.avgLatencyMs ?? 0} ms` },
              ]" :key="card.label" class="surface rounded-xl p-3">
                <div class="text-[10.5px] text-[var(--muted)]">{{ card.label }}</div>
                <div class="text-[18px] font-semibold mt-0.5">{{ card.value }}</div>
              </div>
            </div>
            <div class="surface rounded-xl p-4">
              <h3 class="text-[12px] font-semibold mb-3">By provider</h3>
              <div v-if="!store.analytics?.byPlatform?.length" class="text-[11.5px] text-[var(--muted)]">No requests recorded yet.</div>
              <div v-for="row in store.analytics?.byPlatform" :key="row.platform" class="flex items-center gap-3 py-1.5 text-[11.5px]">
                <span class="w-28 truncate font-mono">{{ row.platform }}</span>
                <div class="flex-1 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
                  <div class="h-full bg-[var(--accent)] rounded-full" :style="{ width: `${Math.min(100, (row.requests / Math.max(1, store.analytics?.requests ?? 1)) * 100)}%` }" />
                </div>
                <span class="text-[var(--muted)] w-12 text-right">{{ row.requests }}</span>
                <span class="text-[var(--faint)] w-20 text-right">{{ (row.tokens ?? 0).toLocaleString() }} tok</span>
              </div>
            </div>
          </template>

          <!-- About -->
          <template v-else>
            <div><h2 class="text-[15px] font-semibold">About</h2><p class="text-[12px] text-[var(--muted)] mt-0.5">Architecture and data provenance.</p></div>
            <div class="surface rounded-xl p-4 space-y-3 text-[12px]">
              <div class="flex items-start gap-2"><Database :size="15" class="text-[var(--accent-text)] mt-0.5 shrink-0" />
                <div><strong>SQLite database</strong><div class="text-[var(--muted)] break-all font-mono text-[11px]">{{ connection.health?.dbPath }}</div>
                  <p class="text-[var(--muted)] mt-1">Copied and renamed from <code class="font-mono">freellmapi_bak/server/data/freeapi.db</code>, or created with every required table on first run when that snapshot is absent. Original tables are kept and reused: <code class="font-mono">models</code>, <code class="font-mono">api_keys</code>, <code class="font-mono">settings</code>, <code class="font-mono">fallback_config</code>, <code class="font-mono">requests</code>, <code class="font-mono">embedding_models</code>. New agent tables are prefixed <code class="font-mono">agent_</code>.</p>
                </div>
              </div>
              <div class="border-t hairline pt-3 text-[var(--muted)]">
                <strong class="text-[var(--text)]">Accounts &amp; BYOK</strong> — scrypt password hashes, random 32-byte bearer tokens stored only as SHA-256 hashes, and per-account rows in <code class="font-mono">api_keys</code>, <code class="font-mono">projects</code>, <code class="font-mono">agent_sessions</code>, <code class="font-mono">agent_user_settings</code> and <code class="font-mono">requests</code>. Non-admin accounts are confined to their own workspace folder and have shell access disabled by default.
              </div>
              <div class="border-t hairline pt-3 text-[var(--muted)]">
                <strong class="text-[var(--text)]">Stack</strong> — Node.js 22 + TypeScript (Hono, Vercel AI SDK, better-sqlite3), Vue 3 + Vite + Pinia + Tailwind, Tauri 2 (Rust) for Windows/macOS/Linux desktop and Android/iOS.
              </div>
              <div class="border-t hairline pt-3 text-[var(--muted)]">
                <strong class="text-[var(--text)]">Open-source building blocks</strong> — Vercel AI SDK &amp; openai-compatible adapter, Hono, better-sqlite3, Zod, fast-glob, execa, jsdiff, Shiki, marked, lucide-vue-next, Tailwind CSS, Tauri plugins (shell/dialog).
              </div>
              <div class="flex items-start gap-2 border-t hairline pt-3 text-[var(--amber)]">
                <AlertTriangle :size="14" class="shrink-0 mt-0.5" />
                <span>Keys are encrypted with AES-256-GCM using the ENCRYPTION_KEY from .env. Keep that file backed up; losing it makes the stored provider keys unreadable.</span>
              </div>
            </div>
          </template>

        </div>
      </div>
    </div>
  </div>
</template>
