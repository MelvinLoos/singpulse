// packages/frontend/capacitor.config.ts
import type { CapacitorConfig } from '@capacitor/cli';

// Baked in at build time (CI sets CAP_SERVER_URL) so the TV loads the receiver
// straight from the server's static LAN IP, sidestepping router DNS rebinding filters.
const serverUrl = process.env.CAP_SERVER_URL || 'http://192.168.1.100:3000/tv';

const config: CapacitorConfig = {
  appId: 'app.singpulse.tv',
  appName: 'SingPulse TV',
  webDir: 'dist',
  server: {
    url: serverUrl,
    cleartext: true
  }
};

export default config;
