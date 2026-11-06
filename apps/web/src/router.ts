import { createRouter, createWebHashHistory } from 'vue-router';
import ChatView from './views/ChatView.vue';
import SettingsView from './views/SettingsView.vue';
import { auth } from './api/client';

// Hash history works unchanged inside tauri://localhost, http:// and file://.
const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'chat', component: ChatView },
    { path: '/settings', name: 'settings', component: SettingsView },
    { path: '/:pathMatch(.*)*', redirect: '/' },
  ],
});

/**
 * Protected routes are never reachable while signed out. The login screen is
 * rendered by App.vue (not a route), so the URL stays clean and a refresh
 * always lands on a safe page.
 */
router.beforeEach((to) => {
  if (auth.checked && !auth.user && to.path !== '/') return { path: '/' };
  return true;
});

export default router;
