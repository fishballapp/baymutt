import { defineConfig } from 'tsdown';

// varlock loads a plugin as one self-contained CommonJS file: everything but varlock itself is
// bundled in.
export default defineConfig({
  entry: { plugin: 'src/plugin.ts' },
  format: ['cjs'],
  platform: 'node',
  dts: false,
  sourcemap: false,
  clean: true,
  deps: { alwaysBundle: [/^(?!varlock)/], neverBundle: [/^varlock/] },
  outputOptions: { entryFileNames: '[name].cjs' },
});
