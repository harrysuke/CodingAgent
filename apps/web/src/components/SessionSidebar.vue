<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  Plus, Search, Settings, MessageSquare, Trash2, Moon, Sun, Wifi, WifiOff,
  PanelLeftClose, Code2, CircleDot, X,
} from 'lucide-vue-next';
import { storeToRefs } from 'pinia';
import { useAppStore } from '../stores/app';
import type { Session } from '@codingagent/shared';

const store = useAppStore();
const router = useRouter();
const { sessions, currentId, sidebarOpen, connection } = storeToRefs(store);
const query = ref('');
const renaming = ref<string | null>(null);
const renameValue = ref('');

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  const list = q ? sessions.value.filter(s => s.title.toLowerCase().includes(q)) : sessions.value;
  return list;
});

function groupLabel(session: Session): string {
  const date = new Date(session.updatedAt.replace(' ', 'T') + (session.updatedAt.endsWith('Z') ? '' : 'Z'));
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (date.getTime() >= startOfToday) return 'Today';
  if (date.getTime() >= startOfToday - 86_400_000) return 'Yesterday';
  return 'Earlier';
}

const groups = computed(() => {
  const map = new Map<string, Session[]>();
  for (const s of filtered.value) {
    const key = groupLabel(s);
    const list = map.get(key) ?? [];
    list.push(s);
    map.set(key, list);
  }
  return [...map.entries()];
});

function startRename(session: Session) {
  renaming.value = session.id;
  renameValue.value = session.title;
}
function commitRename(id: string) {
  if (renameValue.value.trim() && renameValue.value.trim() !== sessions.value.find(s => s.id === id)?.title) {
    void store.renameSession(id, renameValue.value.trim());
  }
  renaming.value = null;
}

const dark = ref(document.documentElement.classList.contains('dark'));
function toggleTheme() {
  dark.value = !dark.value;
  document.documentElement.classList.toggle('dark', dark.value);
  localStorage.setItem('codingagent.theme', dark.value ? 'dark' : 'light');
}
</script>

<template>
  <!-- Mobile backdrop -->
  <div v-if="sidebarOpen" class="fixed inset-0 z-30 bg-black/40 md:hidden" @click="store.sidebarOpen = false" />

  <aside
    class="fixed md:static inset-y-0 left-0 z-40 flex w-[264px] shrink-0 flex-col border-r hairline bg-[var(--surface-2)] transition-transform duration-200 md:translate-x-0"
    :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'"
  >
    <!-- Brand -->
    <div class="flex items-center gap-2.5 px-3.5 h-14 border-b hairline safe-top shrink-0">
      <div class="w-8 h-8 rounded-lg bg-[var(--accent)] text-white grid place-items-center shrink-0"><Code2 :size="17" /></div>
      <div class="min-w-0 flex-1">
        <div class="text-[13.5px] font-semibold leading-tight">CodingAgent</div>
        <div class="text-[10px] text-[var(--faint)] leading-tight">OpenCode-style local agent</div>
      </div>
      <button class="md:hidden p-1.5 rounded-lg hover-soft" @click="store.sidebarOpen = false"><X :size="16" /></button>
      <button class="hidden md:block p-1.5 rounded-lg hover-soft text-[var(--muted)]" title="Collapse sidebar" @click="store.sidebarOpen = false"><PanelLeftClose :size="16" /></button>
    </div>

    <!-- New session -->
    <div class="p-3 space-y-2 shrink-0">
      <button class="w-full flex items-center justify-center gap-2 rounded-xl bg-[var(--accent)] text-white px-3 py-2.5 text-[12.5px] font-medium hover:bg-[var(--accent-hover)] focus-ring" @click="store.newSession()">
        <Plus :size="15" /> New session
      </button>
      <div class="relative">
        <Search :size="14" class="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
        <input v-model="query" placeholder="Search sessions"
          class="w-full bg-[var(--surface)] border hairline rounded-lg pl-8 pr-2 py-1.5 text-[12px] outline-none focus:border-[var(--accent)]" />
      </div>
    </div>

    <!-- Session list -->
    <div class="flex-1 overflow-y-auto px-2 pb-2">
      <div v-if="!groups.length" class="text-center text-[12px] text-[var(--muted)] py-10">No sessions yet.</div>
      <div v-for="[label, list] in groups" :key="label" class="mb-2">
        <div class="px-2 py-1.5 text-[10px] uppercase tracking-wider font-semibold text-[var(--faint)]">{{ label }}</div>
        <div v-for="session in list" :key="session.id"
          class="group relative flex items-center gap-2 rounded-lg px-2.5 py-2 cursor-pointer transition-colors"
          :class="session.id === currentId ? 'bg-[var(--accent-soft)] text-[var(--accent-text)]' : 'hover-soft'"
          @click="store.selectSession(session.id)">
          <MessageSquare :size="14" class="shrink-0 opacity-70" />
          <div class="min-w-0 flex-1" @dblclick.stop="startRename(session)">
            <input v-if="renaming === session.id" v-model="renameValue" autofocus
              class="w-full bg-transparent text-[12px] outline-none border-b border-[var(--accent)]"
              @click.stop @keydown.enter="commitRename(session.id)" @keydown.esc="renaming = null" @blur="commitRename(session.id)" />
            <template v-else>
              <div class="text-[12px] font-medium truncate">{{ session.title }}</div>
              <div class="text-[10px] truncate opacity-60">{{ session.modelPlatform ?? 'no model' }} · {{ session.agent }}</div>
            </template>
          </div>
          <CircleDot v-if="session.status === 'running'" :size="10" class="text-[var(--green)] shrink-0 pulse-ring" />
          <button class="hidden group-hover:block p-1 rounded hover:bg-[var(--red-soft)] text-[var(--red)] shrink-0"
            title="Delete session" @click.stop="store.deleteSession(session.id)">
            <Trash2 :size="12" />
          </button>
        </div>
      </div>
    </div>

    <!-- Footer -->
    <div class="border-t hairline p-2 space-y-0.5 shrink-0 safe-bottom">
      <div class="flex items-center gap-2 px-2 py-1.5 text-[11px]" :class="connection.connected ? 'text-[var(--green)]' : 'text-[var(--red)]'">
        <Wifi v-if="connection.connected" :size="13" /><WifiOff v-else :size="13" />
        <span class="truncate">{{ connection.connected ? `Connected${connection.health ? ` · ${connection.health.models} models` : ''}` : 'Server offline' }}</span>
      </div>
      <button class="w-full flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] hover-soft"
        :class="{ 'bg-[var(--accent-soft)] text-[var(--accent-text)]': router.currentRoute.value.path === '/settings' }"
        @click="router.push('/settings'); store.sidebarOpen = false">
        <Settings :size="14" /> Settings
      </button>
      <button class="w-full flex items-center gap-2 rounded-lg px-2 py-2 text-[12px] hover-soft" @click="toggleTheme">
        <Moon v-if="!dark" :size="14" /><Sun v-else :size="14" /> {{ dark ? 'Light mode' : 'Dark mode' }}
      </button>
    </div>
  </aside>
</template>
