import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.samuel2793.pirateflix',
  appName: 'pirateflix',
  webDir: 'dist/pirateflix/browser',
  server: {
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  plugins: {
    CapacitorNodeJS: {
      nodeDir: 'nodejs-project',
      startMode: 'manual',
    },
  },
};

export default config;
