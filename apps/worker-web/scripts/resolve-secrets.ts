#!/usr/bin/env node
/** Writes the Worker's runtime secrets from process.env to JSON for `wrangler deploy --secrets-file`. */
import { writeFileSync } from 'node:fs';
import secretKeys from './secret-keys.json' with { type: 'json' };

const SECRET_KEYS: readonly string[] = secretKeys;

const outFile = process.argv[2];
if (!outFile) {
  console.error('Usage: varlock run -- node scripts/resolve-secrets.ts <out-file>');
  process.exit(1);
}

const missing = SECRET_KEYS.filter(key => !process.env[key]);
if (missing.length > 0) {
  console.error(`Could not load from baymutt: ${missing.join(', ')}`);
  console.error('Check the service account key and the project named in .env.schema.');
  process.exit(1);
}

writeFileSync(
  outFile,
  JSON.stringify(Object.fromEntries(SECRET_KEYS.map(key => [key, process.env[key]]))),
  { mode: 0o600 },
);
