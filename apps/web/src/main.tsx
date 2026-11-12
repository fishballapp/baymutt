// Safari has no native Temporal, so it alone downloads the polyfill. The app is imported after
// it, never statically, so no module reads `Temporal` before the polyfill has installed it.
if (!('Temporal' in globalThis)) await import('temporal-polyfill/global');
await import('./app.tsx');

export {};
