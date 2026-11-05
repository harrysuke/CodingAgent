import { createRouter, createWebHashHistory } from 'vue-router';
import ChatView from './views/ChatView.vue';
import SettingsView from './views/SettingsView.vue';

// Hash history works unchanged inside tauri://localhost, http:// and file://.
export default createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'chat', component: ChatView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});
