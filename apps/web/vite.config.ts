import { stripHtmlComments } from '@internal/vite-plugins/strip-html-comments';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The SPA builds to ./dist, which @baymutt/worker-web serves on the same origin as its /api/*.
// In dev, /api goes to that Worker's `wrangler dev` (port 8790), so the origin a passkey is bound
// to is this server's. The port is fixed and strict: it is the origin the Worker trusts in
// development (`src/platform/config.ts`).
// tanstackRouter() must precede react(): it generates src/routeTree.gen.ts from src/routes/*.
export default defineConfig({
  plugins: [
    tanstackRouter({ target: 'react', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
    stripHtmlComments(),
  ],
  server: {
    port: 5183,
    strictPort: true,
    proxy: { '/api': { target: 'http://localhost:8790' } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
