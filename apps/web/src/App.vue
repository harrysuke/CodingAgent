<script setup lang="ts">
import { onMounted, ref } from 'vue';
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

async function boot() {
  bootError.value = '';
  booting.value = true;
  try { await store.bootstrap(); }
  catch (err) { bootError.value = (err as Error).message; }
  finally { booting.value = false; }
}

function onAuthenticated() {
  // A fresh account/session must reload every account-scoped collection.
  void boot();
}

onMounted(() => {
  if (window.innerWidth < 768) store.sidebarOpen = false;
  void boot();
});
</script>

<template>
  <div class="flex h-full w-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
    <!-- Starting up -->
    <div v-if="!store.ready || !auth.checked" class="flex-1 grid place-items-center">
      <div class="flex flex-col items-center gap-3 text-[var(--muted)] fade-up">
        <div class="w-12 h-12 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-text)] grid place-items-center"><Code2 :size="22" /></div>
        <Loader2 :size="16" class="animate-spin" />
        <span class="text-[11.5px]">Starting CodingAgent…</span>
        <span v-if="bootError" class="text-[11px] text-[var(--red)]">{{ bootError }}</span>
      </div>
    </div>

    <!-- Signed out: full-screen login / first-run owner setup -->
    <AuthView v-else-if="!auth.user" class="flex-1" @authenticated="onAuthenticated" />

    <!-- Signed in -->
    <template v-else>
      <SessionSidebar />
      <div class="flex flex-1 min-w-0 min-h-0 flex-col">
        <div v-if="!store.connection.connected && !store.sessions.length" class="flex-1 grid place-items-center p-6 overflow-y-auto">
          <div class="max-w-md text-center fade-up">
            <div class="w-14 h-14 rounded-2xl bg-[var(--red-soft)] text-[var(--red)] grid place-items-center mx-auto mb-5"><WifiOff :size="24" /></div>
            <h1 class="text-[17px] font-semibold mb-2">Server unreachable</h1>
            <div v-if="store.connection.error" class="text-left text-[11.5px] rounded-xl border hairline bg-[var(--surface)] p-3 mb-4 break-words text-[var(--red)]">{{ store.connection.error }}</div>
            <button class="flex items-center gap-1.5 mx-auto rounded-lg bg-[var(--accent)] text-white px-3.5 py-2 text-[12px] font-medium" :disabled="booting" @click="boot">
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
