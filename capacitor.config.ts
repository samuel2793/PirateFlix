/// <reference types="@strasberry/capacitor-cast" />

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
    Cast: {
      receiverApplicationId: 'CC1AD845',
      uiMode: 'picker',
      autoJoinPolicy: 'origin_scoped',
    },
    CapacitorNodeJS: {
      nodeDir: 'nodejs-project',
      startMode: 'manual',
    },
  },
};

export default config;
