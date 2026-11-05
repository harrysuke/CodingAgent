import { createApp } from 'vue';
import { createPinia } from 'pinia';
import router from './router';
import App from './App.vue';
import './style.css';

const saved = localStorage.getItem('codingagent.theme');
const prefersDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
if (saved === 'dark' || (!saved || saved === 'system') && prefersDark) {
  document.documentElement.classList.add('dark');
}

createApp(App).use(createPinia()).use(router).mount('#app');
