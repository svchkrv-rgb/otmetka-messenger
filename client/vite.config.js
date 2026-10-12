import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В режиме разработки запросы к API проксируются на локальный сервер.
const SERVER = process.env.OTMETKA_SERVER || 'http://localhost:8080';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': SERVER,
      '/files': SERVER,
      '/ws': { target: SERVER.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    target: 'es2021',
    chunkSizeWarningLimit: 1000,
  },
});
