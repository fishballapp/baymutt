import { preloadDynamicImport } from '@internal/vite-plugins/preload-dynamic-import';
import { stripHtmlComments } from '@internal/vite-plugins/strip-html-comments';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const webPort = Number(process.env.BAYMUTT_WEB_PORT ?? 5183);
const workerPort = Number(process.env.BAYMUTT_WORKER_PORT ?? 8790);

// The SPA builds to ./dist, which @baymutt/worker-web serves on the same origin as its /api/*.
// In dev, /api goes to that Worker's `wrangler dev`, so the origin a passkey is bound to is this
// server's. The port is strict: the Worker trusts exactly this origin in development, and its dev
// script builds that origin from the same BAYMUTT_WEB_PORT. Both ports come from the environment
// (5183 and 8790 by default), so several checkouts can each run their own pair.
// tanstackRouter() must precede react(): it generates src/routeTree.gen.ts from src/routes/*.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    preloadDynamicImport('/src/app.tsx'),
    stripHtmlComments(),
  ],
  server: {
    port: webPort,
    strictPort: true,
    proxy: { '/api': { target: `http://localhost:${workerPort}` } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
