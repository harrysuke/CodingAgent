<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  User, Bot, Brain, AlertCircle, ChevronRight, FileCode2, FileText, FileJson, FilePlus2,
  TriangleAlert,
} from 'lucide-vue-next';
import type { Message } from '@codingagent/shared';
import MarkdownBlock from './MarkdownBlock.vue';
import ToolCallCard from './ToolCallCard.vue';

const props = defineProps<{ message: Message; streaming?: boolean }>();
const showReasoning = ref(false);
const reasoningParts = computed(() => props.message.parts.filter(p => p.type === 'reasoning'));
const visibleParts = computed(() => props.message.parts.filter(p => p.type !== 'reasoning'));
const isLastPartStreaming = computed(() => props.streaming && visibleParts.value.length > 0);

interface AttachmentChip {
  path: string; name: string; size: number; truncated: boolean; external: boolean; kind: string; tokens: number;
}

/** Attachment metadata persisted with the user turn (content itself is not stored). */
const attachments = computed<AttachmentChip[]>(() => {
  const part = props.message.parts.find(p => p.type === 'attachment');
  const input = part?.input as { attachments?: AttachmentChip[] } | undefined;
  return input?.attachments ?? [];
});

const attachmentErrors = computed<string[]>(() => {
  const part = props.message.parts.find(p => p.type === 'attachment');
  const input = part?.input as { errors?: Array<{ path: string; error: string }> } | undefined;
  return (input?.errors ?? []).map(item => `${item.path}: ${item.error}`);
});

function sizeLabel(bytes: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(name: string) {
  const kind = (name.split('.').pop() ?? '').toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx', 'vue', 'py', 'rs', 'go', 'java', 'c', 'cpp', 'h'].includes(kind)) return FileCode2;
  if (['json', 'yaml', 'yml', 'toml'].includes(kind)) return FileJson;
  if (['md', 'txt', 'log'].includes(kind)) return FileText;
  return FilePlus2;
}
</script>

<template>
  <div class="py-3 fade-up" :class="message.role === 'user' ? '' : ''">
    <!-- User -->
    <div v-if="message.role === 'user'" class="flex justify-end gap-2.5">
      <div class="max-w-[88%] sm:max-w-[75%] rounded-2xl rounded-tr-sm bg-[var(--accent-soft)] border border-[var(--accent)]/15 px-3.5 py-2.5">
        <p v-for="(part, i) in message.parts.filter(p => p.type === 'text')" :key="part.id" class="text-[13.5px] whitespace-pre-wrap break-words leading-relaxed" :class="i > 0 ? 'mt-2' : ''">{{ part.text }}</p>

        <div v-if="attachments.length" class="flex items-center gap-1.5 flex-wrap mt-2">
          <div v-for="file in attachments" :key="file.path"
            class="flex items-center gap-1.5 rounded-lg border border-[var(--accent)]/20 bg-[var(--surface)] pl-1.5 pr-2 py-1 max-w-[240px]"
            :title="file.path">
            <component :is="iconFor(file.name)" :size="12" class="text-[var(--accent-text)] shrink-0" />
            <span class="text-[10.5px] font-mono truncate">{{ file.name }}</span>
            <span class="text-[9px] text-[var(--faint)] shrink-0">{{ sizeLabel(file.size) }}</span>
            <span v-if="file.truncated" class="text-[8.5px] px-1 rounded bg-[var(--amber-soft)] text-[var(--amber)] shrink-0">truncated</span>
          </div>
        </div>
        <div v-if="attachmentErrors.length" class="mt-1.5 space-y-0.5">
          <div v-for="problem in attachmentErrors" :key="problem" class="flex items-start gap-1 text-[10px] text-[var(--amber)]">
            <TriangleAlert :size="10" class="shrink-0 mt-0.5" /><span>{{ problem }}</span>
          </div>
        </div>
      </div>
      <div class="w-7 h-7 rounded-lg bg-[var(--surface-3)] border hairline grid place-items-center shrink-0 mt-0.5"><User :size="14" class="text-[var(--muted)]" /></div>
    </div>

    <!-- Assistant -->
    <div v-else class="flex gap-2.5">
      <div class="w-7 h-7 rounded-lg bg-[var(--accent)] text-white grid place-items-center shrink-0 mt-0.5"><Bot :size="15" /></div>
      <div class="min-w-0 flex-1">
        <div v-if="reasoningParts.length" class="mb-2">
          <button class="flex items-center gap-1.5 text-[11px] text-[var(--muted)] hover:text-[var(--text)]" @click="showReasoning = !showReasoning">
            <Brain :size="12" /><ChevronRight :size="12" class="transition-transform" :class="{ 'rotate-90': showReasoning }" />
            Reasoning ({{ reasoningParts.length }})
          </button>
          <div v-if="showReasoning" class="mt-1.5 rounded-lg border hairline bg-[var(--surface-2)] px-3 py-2 text-[12px] text-[var(--muted)] whitespace-pre-wrap max-h-56 overflow-auto">
            {{ reasoningParts.map(p => p.text).join('\n') }}
          </div>
        </div>

        <template v-for="(part, index) in visibleParts" :key="part.id">
          <MarkdownBlock v-if="part.type === 'text' && (part.text || '').length" :source="part.text ?? ''" />
          <div v-else-if="part.type === 'text'" class="h-1" />
          <ToolCallCard v-else-if="part.type === 'tool'" :part="part" />
          <div v-else-if="part.type === 'error'" class="my-2 flex items-start gap-2 rounded-lg border border-[var(--red)]/25 bg-[var(--red-soft)] px-3 py-2 text-[12px] text-[var(--red)]">
            <AlertCircle :size="14" class="shrink-0 mt-0.5" /><span>{{ part.text }}</span>
          </div>
          <div v-else-if="part.type === 'step'" class="my-2 border-t hairline" />
          <span v-if="isLastPartStreaming && index === visibleParts.length - 1 && part.type === 'text' && part.state === 'running'"
            class="inline-block w-1.5 h-3.5 align-middle bg-[var(--accent)] cursor-blink ml-0.5" />
        </template>

        <div v-if="streaming && !visibleParts.length" class="flex items-center gap-2 text-[12px] text-[var(--muted)] py-1">
          <span class="inline-flex gap-1">
            <span class="w-1.5 h-1.5 rounded-full bg-[var(--accent)] cursor-blink" />
            <span class="w-1.5 h-1.5 rounded-full bg-[var(--accent)] cursor-blink" style="animation-delay: .18s" />
            <span class="w-1.5 h-1.5 rounded-full bg-[var(--accent)] cursor-blink" style="animation-delay: .36s" />
          </span>
          Thinking
        </div>
      </div>
    </div>
  </div>
</template>
