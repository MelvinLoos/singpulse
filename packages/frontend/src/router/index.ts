import { createRouter, createWebHistory } from 'vue-router';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/tv',
      name: 'tv',
      component: () => import('../views/TvPlayerView.vue'),
      meta: { title: 'SingPulse // Stage Receiver' }
    },
    {
      path: '/remote',
      name: 'remote',
      component: () => import('../views/MobileRemoteView.vue'),
      meta: { title: 'SingPulse // Remote' }
    },
    // Guests who type the bare host land on the remote; the query (token) is preserved
    { path: '/', redirect: (to) => ({ path: '/remote', query: to.query }) },
    { path: '/:pathMatch(.*)*', redirect: (to) => ({ path: '/remote', query: to.query }) }
  ]
});

router.afterEach((to) => {
  if (typeof to.meta.title === 'string') document.title = to.meta.title;
});

export default router;
