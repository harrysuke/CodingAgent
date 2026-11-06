<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import {
  Code2, KeyRound, ShieldCheck, AlertTriangle, Loader2, LogIn, UserPlus, Server, WifiOff, ArrowRight,
} from 'lucide-vue-next';
import {
  auth, checkHealth, clearSessionToken, connection, loadAuthStatus, restoreSession,
  setServerUrl, signIn, signUp,
} from '../api/client';

const mode = ref<'login' | 'register'>('login');
const email = ref('');
const password = ref('');
const name = ref('');
const setupToken = ref('');
const busy = ref(false);
const error = ref('');
const serverUrl = ref(connection.url);
const editingUrl = ref(false);

const needsSetup = computed(() => auth.status?.needsSetup ?? false);
const registrationOpen = computed(() => auth.status?.registrationOpen ?? true);
const offline = computed(() => !connection.connected);

function prefillSetup() {
  if (needsSetup.value) {
    mode.value = 'register';
    if (!setupToken.value) setupToken.value = connection.setupTokenHint;
  }
}
onMounted(prefillSetup);
watch(needsSetup, prefillSetup);

async function submit() {
  error.value = '';
  busy.value = true;
  try {
    if (mode.value === 'login') {
      await signIn(email.value.trim(), password.value);
    } else {
      await signUp({
        email: email.value.trim(),
        password: password.value,
        name: name.value.trim() || undefined,
        setupToken: needsSetup.value ? setupToken.value.trim() : undefined,
      });
    }
    password.value = '';
    // No emit here: applyAuthResult() already signalled auth.loginEpoch before
    // auth.user changed, and this component is about to be unmounted.
  } catch (err) {
    error.value = (err as Error).message;
  } finally {
    busy.value = false;
  }
}

async function saveServer() {
  setServerUrl(serverUrl.value);
  clearSessionToken();
  auth.user = null;
  editingUrl.value = false;
  error.value = '';
  await checkHealth();
  await restoreSession();
}

async function retryServer() {
  await checkHealth();
  await loadAuthStatus();
}
</script>

<template>
  <div class="flex h-full w-full items-center justify-center overflow-y-auto bg-[var(--bg)] p-5 text-[var(--text)]">
    <div class="w-full max-w-[420px] fade-up">
      <!-- Brand -->
      <div class="flex flex-col items-center text-center mb-6">
        <div class="mb-3 grid h-12 w-12 place-items-center rounded-2xl bg-[var(--accent)] text-white"><Code2 :size="24" /></div>
        <h1 class="text-[19px] font-semibold tracking-tight">CodingAgent</h1>
        <p class="mt-1 text-[12px] text-[var(--muted)]">Your own keys. Your own workspace. Your own account.</p>
      </div>

      <!-- Server is an old bundle / unreachable -->
      <div v-if="auth.staleServer" class="mb-3 rounded-xl border border-[var(--amber)]/40 bg-[var(--amber-soft)] p-3 text-[11.5px] text-[var(--amber)]">
        <div class="flex items-start gap-2"><AlertTriangle :size="14" class="mt-0.5 shrink-0" />
          <span>This server has no accounts API — it is an older build. Restart it (<code class="font-mono">npm start</code>, or Ctrl+C then <code class="font-mono">npm run dev</code>) and reload this page.</span>
        </div>
      </div>
      <div v-else-if="offline" class="mb-3 rounded-xl border hairline bg-[var(--surface)] p-3 text-[11.5px] text-[var(--red)]">
        <div class="flex items-start gap-2"><WifiOff :size="14" class="mt-0.5 shrink-0" />
          <div><div class="font-medium">Cannot reach the agent server.</div>
            <div class="mt-0.5 break-words text-[var(--muted)]">{{ connection.error }}</div>
          </div>
        </div>
      </div>

      <div class="surface rounded-2xl p-5 shadow-sm">
        <!-- Tabs -->
        <div v-if="!needsSetup" class="mb-5 grid grid-cols-2 gap-1 rounded-lg bg-[var(--surface-2)] p-1">
          <button class="flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-medium transition-colors"
            :class="mode === 'login' ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-sm' : 'text-[var(--muted)] hover-soft'"
            @click="mode = 'login'; error = ''"><LogIn :size="13" /> Sign in</button>
          <button class="flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-medium transition-colors"
            :class="mode === 'register' ? 'bg-[var(--surface)] text-[var(--accent-text)] shadow-sm' : 'text-[var(--muted)] hover-soft'"
            :disabled="!registrationOpen" @click="mode = 'register'; error = ''"><UserPlus :size="13" /> Create account</button>
        </div>

        <div v-if="needsSetup" class="mb-4">
          <h2 class="text-[15px] font-semibold">Create the owner account</h2>
          <p class="mt-1 text-[11.5px] leading-relaxed text-[var(--muted)]">
            This is the first account on this server. It will own the provider keys already stored in the database and have full workspace access.
          </p>
        </div>
        <div v-else-if="mode === 'register'" class="mb-4">
          <h2 class="text-[15px] font-semibold">Create your account</h2>
          <p class="mt-1 text-[11.5px] leading-relaxed text-[var(--muted)]">
            New accounts start with <strong>zero API keys</strong> and a private workspace. Add your own key after signing in.
          </p>
        </div>
        <div v-else class="mb-4">
          <h2 class="text-[15px] font-semibold">Welcome back</h2>
          <p class="mt-1 text-[11.5px] text-[var(--muted)]">Sign in to use your own keys and sessions.</p>
        </div>

        <!-- First-run setup token -->
        <div v-if="needsSetup" class="mb-4">
          <label class="block">
            <span class="text-[11px] font-medium text-[var(--muted)]">Setup token <span class="text-[var(--red)]">*</span></span>
            <input v-model="setupToken" type="password" autocomplete="off" placeholder="AGENT_TOKEN from .env"
              class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 font-mono text-[12px] outline-none focus:border-[var(--accent)]" />
          </label>
          <p class="mt-1.5 text-[10.5px] leading-relaxed text-[var(--muted)]">
            One-time secret from <code class="font-mono">.env</code> (desktop: <code class="font-mono">&lt;app-data&gt;/server.env</code>). It stops a stranger from claiming your keys before you do.
          </p>
          <div v-if="auth.status?.setupTokenIsDefault" class="mt-2 flex items-start gap-2 rounded-lg bg-[var(--amber-soft)] px-3 py-2 text-[10.5px] text-[var(--amber)]">
            <AlertTriangle :size="13" class="mt-0.5 shrink-0" />
            <span>AGENT_TOKEN is still the shipped placeholder. Run <code class="font-mono">node scripts/rotate-setup-token.mjs</code> and restart before exposing this server to a network.</span>
          </div>
        </div>
        <div v-else-if="!registrationOpen && mode === 'login'" class="sr-only" />

        <form class="space-y-3" @submit.prevent="submit">
          <label v-if="mode === 'register'" class="block">
            <span class="text-[11px] font-medium text-[var(--muted)]">Name <span class="text-[var(--faint)]">(optional)</span></span>
            <input v-model="name" autocomplete="name" placeholder="Your name"
              class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]" />
          </label>
          <label class="block">
            <span class="text-[11px] font-medium text-[var(--muted)]">Email</span>
            <input v-model="email" type="email" required autocomplete="email" placeholder="you@example.com"
              class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]" />
          </label>
          <label class="block">
            <span class="text-[11px] font-medium text-[var(--muted)]">Password</span>
            <input v-model="password" type="password" required
              :minlength="mode === 'register' ? 8 : 1"
              :autocomplete="mode === 'register' ? 'new-password' : 'current-password'"
              :placeholder="mode === 'register' ? 'At least 8 characters' : 'Your password'"
              class="mt-1 w-full rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] outline-none focus:border-[var(--accent)]" />
          </label>

          <div v-if="error" class="rounded-lg bg-[var(--red-soft)] px-3 py-2 text-[11.5px] text-[var(--red)] break-words">{{ error }}</div>

          <button type="submit" :disabled="busy || auth.staleServer"
            class="flex w-full items-center justify-center gap-1.5 rounded-lg bg-[var(--accent)] px-3.5 py-2.5 text-[12.5px] font-medium text-white hover:bg-[var(--accent-hover)] focus-ring disabled:opacity-60">
            <Loader2 v-if="busy" :size="14" class="animate-spin" />
            <template v-else>{{ needsSetup ? 'Create owner account' : mode === 'login' ? 'Sign in' : 'Create account' }}</template>
            <ArrowRight v-if="!busy" :size="13" />
          </button>
        </form>

        <!-- BYOK promise -->
        <div class="mt-5 flex items-start gap-2 border-t hairline pt-4 text-[11px] leading-relaxed text-[var(--muted)]">
          <ShieldCheck :size="14" class="mt-0.5 shrink-0 text-[var(--green)]" />
          <span>CodingAgent is <strong class="text-[var(--text)]">bring your own key</strong>. Provider keys are encrypted per account and never shared — another user cannot spend your quota or read your sessions.</span>
        </div>
      </div>

      <!-- Server URL (mobile / LAN) -->
      <div class="mt-4 text-center">
        <button class="inline-flex items-center gap-1.5 text-[11px] text-[var(--faint)] hover:text-[var(--accent-text)]" @click="editingUrl = !editingUrl">
          <Server :size="12" /> {{ connection.url || 'Same origin' }}
        </button>
        <div v-if="editingUrl" class="mt-2 flex gap-2">
          <input v-model="serverUrl" placeholder="http://192.168.1.50:4317 (empty = same origin)"
            class="min-w-0 flex-1 rounded-lg border hairline bg-[var(--surface)] px-3 py-2 font-mono text-[11px] outline-none focus:border-[var(--accent)]" />
          <button class="rounded-lg border hairline bg-[var(--surface)] px-3 py-2 text-[11px] font-medium hover-soft" @click="saveServer">Save</button>
        </div>
        <div class="mt-1 flex items-center justify-center gap-1.5">
          <KeyRound :size="11" class="text-[var(--faint)]" />
          <span class="text-[10.5px] text-[var(--faint)]">Changing the server signs you out.</span>
          <button v-if="offline" class="text-[10.5px] text-[var(--accent-text)] underline" @click="retryServer">Retry</button>
        </div>
      </div>
    </div>
  </div>
</template>
