<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{ patch: string; maxLines?: number }>();

interface Line { kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string }

const lines = computed<Line[]>(() => {
  const limit = props.maxLines ?? 160;
  const out: Line[] = [];
  for (const raw of (props.patch ?? '').split(/\r?\n/)) {
    let kind: Line['kind'] = 'ctx';
    if (raw.startsWith('+') && !raw.startsWith('+++')) kind = 'add';
    else if (raw.startsWith('-') && !raw.startsWith('---')) kind = 'del';
    else if (raw.startsWith('@@')) kind = 'hunk';
    else if (raw.startsWith('Index:') || raw.startsWith('===') || raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('diff ')) kind = 'meta';
    out.push({ kind, text: raw });
  }
  return out.slice(0, limit);
});

const clipped = computed(() => (props.patch ?? '').split(/\r?\n/).length > (props.maxLines ?? 160));
</script>

<template>
  <div class="rounded-lg border hairline overflow-hidden bg-[var(--code-bg)]">
    <div class="max-h-80 overflow-auto py-1">
      <div
        v-for="(line, i) in lines" :key="i"
        class="diff-line"
        :class="{
          'diff-add': line.kind === 'add',
          'diff-del': line.kind === 'del',
          'diff-hunk': line.kind === 'hunk',
          'diff-meta': line.kind === 'meta',
          'text-[var(--muted)]': line.kind === 'ctx',
        }"
      ><span class="select-none opacity-60 w-3 shrink-0">{{
        line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''
      }}</span><span>{{ line.text }}</span></div>
    </div>
    <div v-if="clipped" class="px-3 py-1.5 text-[11px] text-[var(--muted)] border-t hairline bg-[var(--surface-2)]">
      Diff truncated to {{ maxLines ?? 160 }} lines.
    </div>
  </div>
</template>
