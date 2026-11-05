<script setup lang="ts">
import { computed, ref } from 'vue';
import { ChevronRight, ChevronDown, FileCode2, RefreshCw, Search } from 'lucide-vue-next';
import type { FileNode } from '@codingagent/shared';
import { useAppStore } from '../stores/app';

const store = useAppStore();
const filter = ref('');
const expanded = ref(new Set<string>(['.']));

interface Row { node: FileNode; depth: number }

function flatten(nodes: FileNode[], depth: number, parentOpen: boolean, out: Row[]): void {
  if (!parentOpen) return;
  for (const node of nodes) {
    out.push({ node, depth });
    if (node.type === 'dir' && node.children?.length) {
      flatten(node.children, depth + 1, expanded.value.has(node.path), out);
    }
  }
}

const rows = computed<Row[]>(() => {
  const q = filter.value.trim().toLowerCase();
  let nodes = store.fileTree;
  if (q) {
    const match = (list: FileNode[]): FileNode[] => list.flatMap(n => {
      const children = n.children ? match(n.children) : [];
      if (n.name.toLowerCase().includes(q) || children.length) return [{ ...n, children: children.length ? children : n.children }];
      return [];
    });
    nodes = match(nodes);
  }
  const out: Row[] = [];
  flatten(nodes, 0, true, out);
  return out;
});

function toggle(node: FileNode) {
  if (node.type !== 'dir') return;
  const next = new Set(expanded.value);
  if (next.has(node.path)) next.delete(node.path); else next.add(node.path);
  expanded.value = next;
}

defineEmits<{ (e: 'open', path: string): void }>();
</script>

<template>
  <div class="flex flex-col h-full min-h-0">
    <div class="p-2.5 border-b hairline space-y-2 shrink-0">
      <div class="flex items-center justify-between">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-[var(--faint)]">Workspace</span>
        <button class="p-1 rounded hover-soft text-[var(--muted)]" title="Refresh" @click="store.loadTree()"><RefreshCw :size="12" /></button>
      </div>
      <div class="relative">
        <Search :size="12" class="absolute left-2 top-1/2 -translate-y-1/2 text-[var(--faint)]" />
        <input v-model="filter" placeholder="Filter files" class="w-full bg-[var(--surface-3)] rounded-md pl-7 pr-2 py-1 text-[11px] outline-none" />
      </div>
    </div>
    <div class="flex-1 overflow-y-auto py-1">
      <div v-if="!rows.length" class="p-4 text-[11px] text-center text-[var(--faint)]">Empty workspace</div>
      <button v-for="row in rows" :key="row.node.path"
        class="w-full flex items-center gap-1.5 pr-2 py-[3px] text-[11.5px] text-left hover-soft group"
        :style="{ paddingLeft: `${8 + row.depth * 13}px` }"
        @click="row.node.type === 'dir' ? toggle(row.node) : $emit('open', row.node.path)">
        <ChevronDown v-if="row.node.type === 'dir' && expanded.has(row.node.path)" :size="12" class="shrink-0 text-[var(--faint)]" />
        <ChevronRight v-else-if="row.node.type === 'dir'" :size="12" class="shrink-0 text-[var(--faint)]" />
        <FileCode2 v-else :size="12" class="shrink-0 text-[var(--muted)]" />
        <span class="truncate" :class="row.node.type === 'dir' ? 'font-medium' : ''">{{ row.node.name }}</span>
      </button>
    </div>
  </div>
</template>
