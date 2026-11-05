<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { RouterView } from 'vue-router';
import { RefreshCw, Settings, WifiOff, Code2 } from 'lucide-vue-next';
import { useRouter } from 'vue-router';
import { useAppStore } from './stores/app';
import SessionSidebar from './components/SessionSidebar.vue';
import PermissionDialog from './components/PermissionDialog.vue';

const store = useAppStore();
const router = useRouter();
const bootError = ref('');
const retrying = ref(false);

async function boot() {
  bootError.value = '';
  try { await store.bootstrap(); }
  catch (err) { bootError.value = (err as Error).message; }
}

async function retry() {
  retrying.value = true;
  await boot();
  retrying.value = false;
}

onMounted(() => {
  if (window.innerWidth < 768) store.sidebarOpen = false;
  void boot();
});
</script>

<template>
  <div class="flex h-full w-full overflow-hidden bg-[var(--bg)] text-[var(--text)]">
    <SessionSidebar />

    <div class="flex flex-1 min-w-0 min-h-0 flex-col">
      <!-- Boot / connection failure screen -->
      <div v-if="!store.ready || (!store.connection.connected && !store.sessions.length)" class="flex-1 grid place-items-center p-6 overflow-y-auto">
        <div class="max-w-md text-center fade-up">
          <div class="w-14 h-14 rounded-2xl bg-[var(--accent-soft)] text-[var(--accent-text)] grid place-items-center mx-auto mb-5"><Code2 :size="26" /></div>
          <h1 class="text-[19px] font-semibold mb-2">CodingAgent</h1>
          <p class="text-[12.5px] text-[var(--muted)] mb-5">
            {{ !store.ready ? 'Starting…' : 'The agent server is not reachable.' }}
          </p>
          <div v-if="store.connection.error" class="text-left text-[11.5px] rounded-xl border hairline bg-[var(--surface)] p-3 mb-4 break-words text-[var(--red)]">
            <WifiOff :size="14" class="inline mr-1" />{{ store.connection.error }}
          </div>
          <div class="flex items-center justify-center gap-2 flex-wrap">
            <button class="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] text-white px-3.5 py-2 text-[12px] font-medium" :disabled="retrying" @click="retry">
              <RefreshCw :size="13" :class="{ 'animate-spin': retrying }" /> Retry
            </button>
            <button class="flex items-center gap-1.5 rounded-lg border hairline bg-[var(--surface)] px-3.5 py-2 text-[12px] font-medium" @click="router.push('/settings')">
              <Settings :size="13" /> Connection settings
            </button>
          </div>
          <p class="text-[11px] text-[var(--faint)] mt-6">
            Desktop: the Tauri shell starts the Node server automatically.<br />
            Dev: <code class="font-mono">npm run dev</code> · Mobile: set your machine's LAN URL + token.
          </p>
        </div>
      </div>

      <RouterView v-else />
    </div>

    <PermissionDialog />
  </div>
</template>
