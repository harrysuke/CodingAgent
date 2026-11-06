<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { RouterView } from 'vue-router';
import { Code2, Loader2, RefreshCw, WifiOff } from 'lucide-vue-next';
import { useAppStore } from './stores/app';
import { auth } from './api/client';
import SessionSidebar from './components/SessionSidebar.vue';
import PermissionDialog from './components/PermissionDialog.vue';
import AuthView from './views/AuthView.vue';

const store = useAppStore();
const bootError = ref('');
const booting = ref(false);

async function boot(afterLogin = false) {
  bootError.value = '';
  booting.value = true;
  try {
    // On first mount we must discover the session; right after a successful
    // login we already have it and only need the account-scoped data.
    if (afterLogin) await store.afterLogin();
    else await store.bootstrap();
  }
  catch (err) { bootError.value = (err as Error).message; }
  finally { booting.value = false; }
}

/**
 * A successful sign-in increments auth.loginEpoch *before* auth.user changes.
 * Watching it with flush:'sync' arms the hydration gate while AuthView is
 * still mounted. Relying on AuthView's emit('authenticated') is unreliable:
 * Vue unmounts the view as soon as auth.user flips, which can happen before
 * the post-await emit runs.
 */
watch(() => auth.loginEpoch, () => {
  store.hydrated = false;
  void boot(true);
}, { flush: 'sync' });

onMounted(() => {
  if (window.innerWidth < 768) store.sidebarOpen = false;
  void boot();
});
</script>

<template>
  <div class="flex h-full w-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
    <!-- Starting up -->
    <div v-if="!store.ready || !auth.checked || (auth.user && !store.hydrated)" class="flex-1 grid place-items-center">
      <div class="flex flex-col items-center gap-3 text-[var(--muted)] fade-up">
        <div class="w-12 h-12 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-text)] grid place-items-center"><Code2 :size="22" /></div>
        <Loader2 :size="16" class="animate-spin" />
        <span class="text-[11.5px]">{{ auth.user ? 'Loading your models and workspace…' : 'Starting CodingAgent…' }}</span>
        <span v-if="bootError" class="text-[11px] text-[var(--red)]">{{ bootError }}</span>
      </div>
    </div>

    <!-- Signed out: full-screen login / first-run owner setup -->
    <AuthView v-else-if="!auth.user" class="flex-1" />

    <!-- Signed in -->
    <template v-else>
      <SessionSidebar />
      <div class="flex flex-1 min-w-0 min-h-0 flex-col">
        <div v-if="bootError" class="shrink-0 border-b hairline bg-[var(--red-soft)] px-4 py-2 text-[11.5px] text-[var(--red)]">{{ bootError }}</div>
        <div v-if="!store.connection.connected && !store.sessions.length" class="flex-1 grid place-items-center p-6 overflow-y-auto">
          <div class="max-w-md text-center fade-up">
            <div class="w-14 h-14 rounded-2xl bg-[var(--red-soft)] text-[var(--red)] grid place-items-center mx-auto mb-5"><WifiOff :size="24" /></div>
            <h1 class="text-[17px] font-semibold mb-2">Server unreachable</h1>
            <div v-if="store.connection.error" class="text-left text-[11.5px] rounded-xl border hairline bg-[var(--surface)] p-3 mb-4 break-words text-[var(--red)]">{{ store.connection.error }}</div>
            <button class="flex items-center gap-1.5 mx-auto rounded-lg bg-[var(--accent)] text-white px-3.5 py-2 text-[12px] font-medium" :disabled="booting" @click="boot()">
              <RefreshCw :size="13" :class="{ 'animate-spin': booting }" /> Retry
            </button>
          </div>
        </div>
        <RouterView v-else />
      </div>
      <PermissionDialog />
    </template>
  </div>
</template>
