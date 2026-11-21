// The lists area's steps: Keys, Activity and Bin.
import type { Page } from '@playwright/test';
import {
  askPlan,
  askPlanRaw,
  check,
  d1,
  keepsVaultOpen,
  MINUTE_MS,
  pick,
  type Run,
  shooter,
  shownIn,
  varlockLoads,
  WEB,
  waitPlan,
} from '../support.ts';
import * as account from './account.ts';
import * as environments from './environments.ts';
import { ACCOUNT_ID } from './plans.ts';

const { shoot, shootPhone } = shooter('lists');

const SIGNING = { SIGNING_KEY: '-----BEGIN KEY-----\nmade-up-line-two\n-----END KEY-----' };

/** The Keys page: kinds, ends, reads and expiry changed by the owner, ended keys. */
export const keysPage = async ({
  ciEnv,
  keyId,
  laptop,
  page,
}: Pick<Run, 'ciEnv' | 'keyId' | 'laptop' | 'page'>) => {
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('CI deploy').waitFor();
  await shoot(page, '11-keys');
  const keysUnder = (heading: string) =>
    page
      .locator('section.list', { has: page.getByRole('heading', { name: heading }) })
      .locator('li.row-key')
      .count();
  check(
    'an org’s Keys tells its service accounts and agent keys apart, with when each ends, and lists no CLI login',
    (await page.locator('li.row-key', { hasText: 'Work laptop' }).count()) === 0 &&
      (await keysUnder('Service accounts')) === 1 &&
      (await keysUnder('Agent keys')) === 1 &&
      (await page.getByText('never expires').count()) === 1 &&
      (await page.getByText(/expires in (1[0-5]|[1-9]) minutes?/).count()) === 1,
  );
  check(
    'each key lists what it reads, and nothing it writes',
    (await page.locator('li.row-key .reach').getByText('write').count()) === 0 &&
      (await page.locator('li.row-key .reach').getByText('read').count()) >= 2,
  );
  await shootPhone(page, '11b-keys-phone');
  await account.cliLogins(page);
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('CI deploy').waitFor();
  const ciRow = page.getByRole('listitem').filter({ hasText: 'CI deploy' });
  /** Opens an item of the CI key's `⋯`. */
  const fromCiMenu = async (item: string) => {
    await ciRow.getByRole('button', { name: 'CI deploy: access, expiry, revoke' }).click();
    await page.getByRole('menuitem', { name: item }).click();
  };
  await fromCiMenu('Revoke');
  await page.getByRole('alertdialog').waitFor();
  await page.waitForTimeout(300);
  await shoot(page, '11e0-revoke');
  await page.getByRole('button', { name: 'Keep key' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  await fromCiMenu('Access');
  const accessDialog = page.getByRole('dialog');
  await accessDialog.waitFor();
  check(
    'the owner gives a key a read and nothing else: there is no write to give',
    (await accessDialog.getByRole('checkbox', { name: 'write' }).count()) === 0,
  );
  await accessDialog
    .getByRole('group', { name: 'acme/worker/staging' })
    .getByRole('checkbox', { name: 'read' })
    .check();
  await page.waitForTimeout(300);
  await shoot(page, '11e-access');
  await page.getByRole('button', { name: 'Save access' }).click();
  await accessDialog.waitFor({ state: 'hidden' });
  await ciRow.getByText('acme/worker/staging', { exact: true }).waitFor();
  check(
    'the owner gives a service account another environment, and it loads it with the key it had',
    varlockLoads(ciEnv, 'acme/worker/staging', { CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID }).isLoaded,
  );
  // A choice cancelled is gone when the dialog opens again, and what it shows is what it saves.
  await fromCiMenu('Expiry');
  await pick(page, 'Expires', 'In 90 days');
  await page.getByRole('button', { name: 'Cancel' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await fromCiMenu('Expiry');
  const shownOnReopen = await shownIn(page, 'Expires');
  await page.getByRole('button', { name: 'Save expiry' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await page.waitForTimeout(500);
  check(
    'an expiry cancelled is not kept: opened again it shows the key’s end, and saves that',
    shownOnReopen === 'Never' && (await ciRow.getByText('never expires').count()) === 1,
  );
  await fromCiMenu('Expiry');
  await pick(page, 'Expires', 'In 30 days');
  await page.waitForTimeout(300);
  await shoot(page, '11f-expiry');
  await page.getByRole('button', { name: 'Save expiry' }).click();
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await ciRow.getByText(/expires in 30 days/).waitFor();
  check('the owner changes when a service account ends', true);
  await shoot(page, '11g-keys-after-access');

  // A key whose end has passed falls out of sight, and one click brings it back.
  const AGENT = 'Stripe webhook check';
  const [agent] = d1(`SELECT expires_at FROM credential WHERE name = '${AGENT}'`);
  const onEndedKey = askPlan(laptop, {
    reason: 'one more hour',
    steps: [{ type: 'change', key: keyId, expires: '1h' }],
  });
  d1(`UPDATE credential SET expires_at = ${Date.now() - MINUTE_MS} WHERE name = '${AGENT}'`);
  await page.goto(onEndedKey.url);
  await page.getByRole('button', { name: 'Reject', exact: true }).waitFor();
  check(
    'a change to a key that has ended can only be rejected',
    (await page.getByText(`${AGENT} has ended. This step can only be rejected.`).count()) === 1 &&
      (await page.getByRole('button', { name: 'Approve change' }).count()) === 0,
  );
  await shoot(page, '11h0-plan-change-ended');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByRole('heading', { name: 'Plan answered' }).waitFor();
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('CI deploy').waitFor();
  check(
    'a key that has ended is hidden, and counted in the button that shows it',
    (await page.getByText(AGENT).count()) === 0 &&
      (await page.getByRole('button', { name: 'Show 1 ended key' }).count()) === 1,
  );
  await page.getByRole('button', { name: 'Show 1 ended key' }).click();
  await page.getByText(AGENT).waitFor();
  check(
    'Show N ended keys says it is open to assistive tech, and the same button hides them again',
    (await page
      .getByRole('button', { name: /^Hide ended keys?$/ })
      .getAttribute('aria-expanded')) === 'true',
  );
  check('the ended key is listed as expired', (await page.getByText('expired').count()) === 1);
  await shoot(page, '11h-keys-ended-shown');
  d1(`UPDATE credential SET expires_at = ${String(agent?.expires_at)} WHERE name = '${AGENT}'`);
};

/** The Bin, a plan naming an environment removed for good, and Activity. */
export const binAndActivity = async ({
  laptop,
  page,
  toPurged,
}: Pick<Run, 'laptop' | 'page' | 'toPurged'>) => {
  await page.getByRole('link', { name: 'Bin' }).first().click();
  await page.getByText('OLD_TOKEN').waitFor();
  await page.getByText('acme/app/old').waitFor();
  await shoot(page, '11h-bin');
  await shootPhone(page, '11i-bin-phone');
  const secretRow = page.getByRole('listitem').filter({ hasText: 'OLD_TOKEN' });
  await secretRow.getByRole('button', { name: 'Restore' }).click();
  await page.getByText('OLD_TOKEN').waitFor({ state: 'detached' });
  check(
    'the owner restores a secret from the bin, and the CLI lists it again',
    laptop
      .cli(['secret', 'list', 'acme/app/production'])
      .json?.secrets?.some((secret: { name: string }) => secret.name === 'OLD_TOKEN') === true,
  );
  await page.getByRole('button', { name: 'acme/app/old: delete for good' }).click();
  await page.getByRole('menuitem', { name: 'Delete for good' }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.waitForTimeout(300);
  await shoot(page, '11i0-bin-delete-for-good');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete for good' }).click();
  await page.getByText(/stays here for 30 days/).waitFor();
  await page.goto(toPurged.url);
  await page.getByRole('button', { name: 'Reject', exact: true }).waitFor();
  check(
    'a step naming an environment removed for good can only be rejected',
    (await page.getByText(/This step can only be rejected\./).count()) === 1 &&
      (await page.getByRole('button', { name: 'Approve change' }).count()) === 0,
  );
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByRole('heading', { name: 'Plan answered' }).waitFor();
  check('and the terminal hears it was not approved', waitPlan(laptop, toPurged.id).status === 4);
  await page.goto(`${WEB}/orgs/acme/environments`);
  await environments.createEnvironment(page, 'app/old');
  await page.getByRole('link', { name: /app\/old/ }).waitFor();
  check('an environment deleted for good frees its name', true);

  await page.goto(`${WEB}/orgs/acme/activity`);
  await page
    .getByText(/approved step \d+ of a plan/)
    .first()
    .waitFor();
  check(
    'the activity shows plans made, steps approved and rejected, and names opened in the browser',
    (await page.getByText(/made a plan/).count()) >= 1 &&
      (await page.getByText(/approved step \d+ of a plan/).count()) >= 1 &&
      (await page.getByText(/rejected step \d+ of a plan/).count()) >= 3 &&
      (await page.getByText('STRIPE_SECRET_KEY').count()) >= 1,
  );
  await shoot(page, '12-activity');
  await shootPhone(page, '12b-activity-phone');
  await account.accountPage(page);
};

/** A key belongs to one org, and a plan waits under its own org. */
export const keyOneOrg = async ({
  ciEnv,
  laptop,
  page,
}: Pick<Run, 'ciEnv' | 'laptop' | 'page'>) => {
  const across = askPlanRaw(laptop, {
    reason: 'both orgs',
    steps: [{ type: 'access', read: ['acme/app/production', 'legacy/app/legacy'] }],
  });
  check(
    'a plan across two orgs is refused, and says to make one per org',
    across.status === 2 && /one plan per org/.test(across.stderr),
  );
  const elsewhere = askPlan(laptop, {
    reason: 'read the legacy app',
    steps: [{ type: 'access', read: ['legacy/app/legacy'] }],
  });
  check(
    'a plan links to its page under its own org',
    elsewhere.url === `${WEB}/orgs/legacy/ask/${elsewhere.id}`,
  );
  await page.goto(`${WEB}/orgs/legacy/plans`);
  await page.getByText('read the legacy app').waitFor();
  await page.getByRole('navigation', { name: 'Legacy Ltd' }).getByText('1 waiting').waitFor();
  await shoot(page, '13k-plans-other-org');
  await page.goto(`${WEB}/orgs/acme/environments`);
  await page.getByRole('link', { name: /acme\/app\/production/ }).waitFor();
  check(
    'a plan waits and is counted under its own org alone',
    (await page
      .getByRole('navigation', { name: 'Acme' })
      .getByText(/\d waiting/)
      .count()) === 0,
  );
  laptop.cli(['ask', 'cancel', elsewhere.id]);

  // The vault stays open across a reload, and a change still goes through.
  await page.goto(`${WEB}/account`);
  await page.reload();
  await page.getByRole('heading', { name: 'Passkeys' }).waitFor();
  check('a reload leaves the vault open', await keepsVaultOpen(page));

  // Logging the laptop out takes the keys it asked for with it.
  const loggedOut = laptop.cli(['auth', 'logout']);
  check(
    '`baymutt auth logout` revokes the login and the keys it asked for',
    loggedOut.json?.status === 'loggedOut' &&
      !varlockLoads(ciEnv, 'acme/app/production', SIGNING).isLoaded,
  );
  check('a logged-out computer is not logged in', laptop.cli(['env', 'list']).status === 3);
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('Acme’s keys show here').waitFor();
  await shoot(page, '14b-keys-empty');
  await account.noCliLogins(page);
};

/** Keys with no key, in the dark scheme. */
export const keysEmptyDark = async (page: Page) => {
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('Acme’s keys show here').waitFor();
  await shoot(page, '16b-keys-empty-dark');
};
