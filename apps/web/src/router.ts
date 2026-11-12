import { createRouter, createWebHistory } from 'vue-router'

const Empty = { render: () => null }

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', redirect: '/t/chief' },
    // A conversation: the general one ("chief") or a project's, with an optional task open beside it.
    { path: '/t/:thread/:open?', name: 'thread', component: () => import('./views/ThreadView.vue') },
    { path: '/team/:id', name: 'member', component: () => import('./views/MemberView.vue') },
    // On a narrow window: just the list of conversations.
    { path: '/list', name: 'list', component: Empty },
    // The first time: which engines are ready, and where the projects are.
    { path: '/welcome', name: 'welcome', component: () => import('./views/WelcomeView.vue'), meta: { bare: true } },
    { path: '/quick', name: 'quick', component: () => import('./views/QuickView.vue'), meta: { bare: true } },
    { path: '/inbox', name: 'inbox', component: () => import('./views/InboxView.vue') },
    { path: '/board', name: 'board', component: () => import('./views/BoardView.vue') },
    { path: '/agents/:id?', name: 'agents', component: () => import('./views/AgentsView.vue') },
    { path: '/projects', name: 'projects', component: () => import('./views/ProjectsView.vue') },
    { path: '/projects/:slug', name: 'project', component: () => import('./views/ProjectView.vue') },
    { path: '/routines', name: 'routines', component: () => import('./views/RoutinesView.vue') },
    { path: '/usage', name: 'usage', component: () => import('./views/UsageView.vue') },
    { path: '/health', name: 'health', component: () => import('./views/HealthView.vue') },
    { path: '/settings/:section?', name: 'settings', component: () => import('./views/SettingsView.vue') },
    { path: '/:rest(.*)', redirect: '/t/chief' },
  ],
})
