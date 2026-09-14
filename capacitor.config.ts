import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'cn.pixelleap.shanjing',
  appName: '山境造像',
  webDir: 'dist',
  server: {
    androidScheme: 'http',
    cleartext: true,
  },
}

export default config
