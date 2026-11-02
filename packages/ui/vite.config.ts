import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `pnpm dev` here proxies the API to a running `necromancer ui` (default port 4173).
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': `http://127.0.0.1:${process.env.NECROMANCER_PORT ?? 4173}` } },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
