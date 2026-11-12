// @ts-check

import sitemap from '@astrojs/sitemap';
import { marketing } from '@internal/marketing/integration';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'astro/config';

// One page, served at / by the baymutt-web Worker on the dashboard's origin
// (../worker-web/scripts/assemble-assets.ts puts this build beside the dashboard's).
export default defineConfig({
  site: 'https://baymutt.fsh.ba',
  trailingSlash: 'never',
  build: { format: 'file' },
  integrations: [sitemap(), marketing()],
  vite: {
    plugins: [tailwindcss()],
  },
});
