<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { marked } from 'marked';

const props = defineProps<{ source: string }>();
const host = ref<HTMLElement | null>(null);

marked.setOptions({ gfm: true, breaks: false });

const html = computed(() => {
  try { return marked.parse(props.source ?? '') as string; }
  catch { return `<p>${escapeHtml(props.source ?? '')}</p>`; }
});

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
}

// Shiki is loaded lazily so the initial bundle stays small; code blocks are
// progressively upgraded once the highlighter is ready.
let highlighter: Awaited<ReturnType<typeof loadHighlighter>> | null = null;
async function loadHighlighter() {
  const { createHighlighter } = await import('shiki');
  return createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: ['typescript', 'javascript', 'vue', 'html', 'css', 'json', 'bash', 'python', 'rust', 'sql', 'yaml', 'markdown', 'diff', 'go', 'java', 'text'],
  });
}

const LANG_ALIASES: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  sh: 'bash', shell: 'bash', zsh: 'bash', console: 'bash', py: 'python',
  rs: 'rust', yml: 'yaml', md: 'markdown', vue3: 'vue',
};

async function highlight(): Promise<void> {
  await nextTick();
  if (!host.value) return;
  const blocks = host.value.querySelectorAll('pre > code');
  if (!blocks.length) return;
  if (!highlighter) {
    try { highlighter = await loadHighlighter(); } catch { return; }
  }
  const loaded = new Set(highlighter.getLoadedLanguages());
  for (const code of Array.from(blocks)) {
    const pre = code.parentElement;
    if (!pre || pre.dataset.highlighted === '1' || pre.classList.contains('shiki')) continue;
    const raw = code.textContent ?? '';
    const cls = Array.from(code.classList).find(c => c.startsWith('language-'));
    let lang = (cls?.replace('language-', '') || 'text').toLowerCase();
    lang = LANG_ALIASES[lang] ?? lang;
    if (!loaded.has(lang as never)) lang = 'text';
    try {
      const out = highlighter.codeToHtml(raw, {
        lang, themes: { light: 'github-light', dark: 'github-dark' },
        defaultColor: false,
      });
      pre.outerHTML = out;
      const replacement = host.value.querySelector('.shiki:not([data-highlighted])');
      if (replacement) replacement.setAttribute('data-highlighted', '1');
    } catch { /* leave plain code on failure */ }
  }
}

onMounted(highlight);
watch(() => props.source, () => { void highlight(); });
</script>

<template>
  <div ref="host" class="prose-agent" v-html="html" />
</template>
