import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    VitePWA({
      strategies: 'generateSW',
      registerType: 'autoUpdate',
      injectRegister: false,
      manifest: {
        id: '/remote',
        name: 'SingPulse Remote',
        short_name: 'SingPulse',
        description: 'Guest remote for SingPulse karaoke: search, queue and control the stage.',
        start_url: '/remote',
        scope: '/',
        display: 'standalone',
        orientation: 'any',
        theme_color: '#070709',
        background_color: '#070709',
        categories: ['music', 'entertainment'],
        launch_handler: { client_mode: 'navigate-existing' },
        icons: [
          { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
          { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
          { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ],
        shortcuts: [
          { name: 'Search songs', short_name: 'Search', url: '/remote?action=search' },
          { name: 'Open setlist', short_name: 'Setlist', url: '/remote?action=setlist' }
        ],
        share_target: {
          action: '/remote',
          method: 'GET',
          enctype: 'application/x-www-form-urlencoded',
          params: { title: 'share_title', text: 'share_text', url: 'share_url' }
        }
      } as Record<string, unknown>,
      workbox: {
        skipWaiting: true,
        clientsClaim: true,
        navigateFallback: 'index.html',
        navigateFallbackAllowlist: [/^\/remote/],
        navigateFallbackDenylist: [/^\/(api|media|ws|tv)/],
        globIgnores: ['**/TvPlayerView-*'],
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com',
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-css' }
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-files',
              expiration: { maxEntries: 30, maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] }
            }
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://i.ytimg.com',
            handler: 'CacheFirst',
            options: {
              cacheName: 'yt-thumbnails',
              expiration: { maxEntries: 150, maxAgeSeconds: 60 * 60 * 24 * 7 },
              cacheableResponse: { statuses: [0, 200] }
            }
          }
        ]
      }
    })
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/media': 'http://localhost:3000',
      '/ws': { target: 'ws://localhost:3000', ws: true }
    }
  }
});
