import { defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config';

// Icons only: iOS builds its launch screen from apple-touch-icon + background_color
export default defineConfig({
  preset: {
    ...minimal2023Preset,
    // Keep the mark inside the maskable safe zone and on the obsidian background
    maskable: { ...minimal2023Preset.maskable, padding: 0, resizeOptions: { background: '#070709' } },
    apple: { ...minimal2023Preset.apple, padding: 0, resizeOptions: { background: '#070709' } }
  },
  images: ['pwa/icon.svg']
});
