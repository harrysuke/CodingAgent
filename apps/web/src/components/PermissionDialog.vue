<script setup lang="ts">
import { computed } from 'vue';
import { ShieldQuestion, Check, CheckCheck, X, Terminal, FileCode2 } from 'lucide-vue-next';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const permission = computed(() => store.pendingPermission);
const input = computed<Record<string, unknown>>(() => (permission.value?.input ?? {}) as Record<string, unknown>);

const preview = computed(() => {
  const p = permission.value;
  if (!p) return '';
  if (p.toolName === 'bash') return `$ ${String(input.value.command ?? '')}`;
  if (p.toolName === 'write') return String(input.value.content ?? '').slice(0, 4000);
  if (p.toolName === 'edit') {
    return `--- ${String(input.value.filePath ?? '')}\n- ${String(input.value.oldString ?? '').split('\n').join('\n- ')}\n+ ${String(input.value.newString ?? '').split('\n').join('\n+ ')}`;
  }
  try { return JSON.stringify(input.value, null, 2); } catch { return ''; }
});

function decide(decision: 'approved' | 'denied' | 'approved_always') {
  if (!permission.value) return;
  void store.resolvePermission(permission.value.id, decision);
}
</script>

<template>
  <Teleport to="body">
    <div v-if="permission" class="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/45 p-0 sm:p-4 safe-bottom">
      <div class="w-full sm:max-w-lg surface rounded-t-2xl sm:rounded-2xl shadow-[var(--shadow)] overflow-hidden fade-up">
        <div class="flex items-center gap-2.5 px-4 py-3 border-b hairline bg-[var(--amber-soft)]">
          <ShieldQuestion :size="17" class="text-[var(--amber)] shrink-0" />
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-semibold">Permission required</div>
            <div class="text-[11px] text-[var(--muted)] truncate">The agent wants to run <code class="font-mono">{{ permission.toolName }}</code></div>
          </div>
        </div>

        <div class="p-4 space-y-3">
          <div class="flex items-center gap-2 text-[12px]">
            <component :is="permission.toolName === 'bash' ? Terminal : FileCode2" :size="14" class="text-[var(--accent-text)]" />
            <span class="font-medium">{{ permission.toolName }}</span>
            <span v-if="input.filePath" class="font-mono text-[11px] text-[var(--muted)] truncate">{{ input.filePath }}</span>
          </div>

          <div class="rounded-lg border hairline bg-[var(--code-bg)] max-h-60 overflow-auto">
            <div v-for="(line, i) in preview.split('\n')" :key="i" class="diff-line"
              :class="{ 'diff-add': line.startsWith('+'), 'diff-del': line.startsWith('-') }">{{ line }}</div>
          </div>

          <p class="text-[11px] text-[var(--muted)]">
            This action changes your workspace. "Always allow" grants this tool for the rest of the session only.
          </p>
        </div>

        <div class="flex flex-wrap gap-2 px-4 pb-4 justify-end">
          <button class="flex items-center gap-1.5 rounded-lg border hairline px-3 py-2 text-[12px] hover-soft focus-ring" @click="decide('denied')">
            <X :size="14" /> Deny
          </button>
          <button class="flex items-center gap-1.5 rounded-lg border hairline px-3 py-2 text-[12px] hover-soft focus-ring" @click="decide('approved_always')">
            <CheckCheck :size="14" /> Always allow
          </button>
          <button class="flex items-center gap-1.5 rounded-lg bg-[var(--accent)] text-white px-3.5 py-2 text-[12px] font-medium hover:bg-[var(--accent-hover)] focus-ring" @click="decide('approved')">
            <Check :size="14" /> Allow once
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>
