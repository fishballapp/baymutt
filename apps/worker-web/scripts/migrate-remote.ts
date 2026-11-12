#!/usr/bin/env node
/**
 * Applies the D1 migrations to production. Runs under `varlock run`, so the deploy token is in the
 * env; it reaches wrangler as CLOUDFLARE_API_TOKEN for this call only.
 */
import { execFileSync } from 'node:child_process';

const deployToken = process.env.CLOUDFLARE_DEPLOY_TOKEN;
if (!deployToken) throw new Error('Need CLOUDFLARE_DEPLOY_TOKEN in the env.');

execFileSync('wrangler', ['d1', 'migrations', 'apply', 'baymutt', '--remote'], {
  stdio: 'inherit',
  env: { ...process.env, CLOUDFLARE_API_TOKEN: deployToken, CI: 'true' },
});
