import { defineConfig } from 'tsdown';

// Everything is bundled (effect, @effect/platform-node, the workspace packages are
// devDependencies), so the CLI installs with zero dependencies.
export default defineConfig({
  entry: {
    bin: 'src/bin.ts',
  },
  format: ['esm'],
  platform: 'node',
  // A bin-only package: no declarations (tsdown would otherwise infer them from `composite`).
  dts: false,
  sourcemap: false,
  minify: true,
  clean: true,
  outputOptions: {
    entryFileNames: '[name].js',
  },
});
