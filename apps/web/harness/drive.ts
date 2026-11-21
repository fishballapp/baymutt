/**
 * Drives the whole product in a real browser against `wrangler dev`: the dashboard with a virtual
 * passkey, the built CLI, and the built varlock plugin. Needs both dev servers up on a fresh local
 * database, and the CLI and plugin built:
 *
 *   pnpm -F @baymutt/worker-web dev        # :$BAYMUTT_WORKER_PORT, 8790 by default
 *   pnpm -F @baymutt/web dev               # :$BAYMUTT_WEB_PORT, 5183 by default
 *   pnpm -F @baymutt/cli build && pnpm -F @baymutt/varlock-plugin build
 *   pnpm -F @baymutt/web drive             # DRIVE_SHOTS=<area,…> saves those areas' screens alone
 *
 * Chromium only: its CDP virtual authenticator can do PRF headlessly. Screens land in
 * `apps/web/tmp/drive/`. Every value here is made up for the run.
 *
 * This file is the order of the flow and nothing else. Each step lives with the area whose screens
 * it shoots (`areas/*.ts`), or in `spine.ts`; the helpers and the state steps share are
 * `support.ts`. Later steps build on what earlier ones made, so they run as one flow, in this order.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { type Browser, chromium } from '@playwright/test';
import * as account from './areas/account.ts';
import * as approvals from './areas/approvals.ts';
import * as asks from './areas/asks.ts';
import * as environments from './areas/environments.ts';
import * as lists from './areas/lists.ts';
import * as spine from './spine.ts';
import { shots } from './support.ts';

const main = async (browser: Browser) => {
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });
  const { context, page, recoveryKey } = await account.signUp({ browser });
  await environments.firstSecret({ context, page });
  const { laptop, production } = await approvals.pairing({ browser, page });
  const { keyId } = await asks.asks({ laptop, page });
  await approvals.unopenedNames({ laptop, page, production });
  const { ci, ciEnv } = await approvals.ciKey({ laptop, page });
  await lists.keysPage({ ciEnv, keyId, laptop, page });
  const { toPurged } = await environments.environmentPage({ keyId, laptop, page });
  await lists.binAndActivity({ laptop, page, toPurged });
  await spine.legacyOrg({ ci, laptop, page });
  await account.deleteOrg({ laptop, page });
  await approvals.decisionsDark({ laptop, page });
  await lists.keyOneOrg({ ciEnv, laptop, page });
  await spine.darkAndPhone({ context, page });
  await account.secondPerson({ browser });
  await account.recovery({ browser, recoveryKey });
  for (const directory of [laptop.home, ci.home]) {
    rmSync(directory, { recursive: true, force: true });
  }
  console.log(`\nAll checks passed. Screens: ${shots}`);
};

const browser = await chromium.launch({ args: ['--mute-audio'] });
try {
  await main(browser);
} finally {
  await browser.close();
}
