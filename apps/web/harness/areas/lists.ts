// The lists area's steps: Keys, Paste links, Activity and Bin.
import type { Page } from '@playwright/test';
import {
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
} from '../support.ts';
import * as account from './account.ts';
import * as environments from './environments.ts';

const { shoot, shootPhone } = shooter('lists');

/** The Keys page: kinds, ends, access and expiry changed by the owner, ended keys. */
export const keysPage = async ({
  changeKey,
  ciEnv,
  page,
}: Pick<Run, 'changeKey' | 'ciEnv' | 'page'>) => {
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
      (await keysUnder('Agent keys')) === 2 &&
      (await page.getByText('never expires').count()) === 1 &&
      // The migration agent's end, as its key change set it.
      (await page.getByText(/expires in 2 hours/).count()) === 1 &&
      (await page.getByText(/expires in (1 hour|5[0-9] minutes)/).count()) === 1,
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
  await accessDialog
    .getByRole('group', { name: 'acme/app/staging' })
    .getByRole('checkbox', { name: 'read' })
    .check();
  await page.waitForTimeout(300);
  await shoot(page, '11e-access');
  await page.getByRole('button', { name: 'Save access' }).click();
  await accessDialog.waitFor({ state: 'hidden' });
  await ciRow.getByText('acme/app/staging', { exact: true }).waitFor();
  check(
    'the owner gives a service account another environment, and it loads it with the key it had',
    varlockLoads(ciEnv, 'acme/app/staging', { API_KEY: 'staging-value' }).isLoaded,
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
  const [migration] = d1(`SELECT expires_at FROM credential WHERE name = 'Migration agent'`);
  const onEndedKey = changeKey(['--read', 'acme/app/staging', '--reason', 'one more environment']);
  d1(`UPDATE credential SET expires_at = ${Date.now() - MINUTE_MS} WHERE name = 'Migration agent'`);
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('CI deploy').waitFor();
  const keysWaiting = () =>
    page
      .getByRole('navigation', { name: 'Acme' })
      .getByRole('link', { name: /^Keys/ })
      .getByText(/\d waiting/)
      .count();
  check(
    'a change to a key that has ended waits on nobody: not counted, not listed',
    onEndedKey.json?.status === 'pending' &&
      (await keysWaiting()) === 0 &&
      (await page.getByText(/asks to change/).count()) === 0,
  );
  await page.goto(onEndedKey.json.url);
  await page.getByRole('button', { name: 'Reject' }).waitFor();
  check(
    'its page says the key has ended and offers only Reject',
    (await page.getByText(/has ended, so this change cannot be approved/).count()) === 1 &&
      (await page.getByRole('button', { name: /^Approve/ }).count()) === 0,
  );
  await shoot(page, '11h0-key-change-ended');
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('CI deploy').waitFor();
  check(
    'a key that has ended is hidden, and counted in the button that shows it',
    (await page.getByText('Migration agent').count()) === 0 &&
      (await page.getByRole('button', { name: 'Show 1 ended key' }).count()) === 1,
  );
  await page.getByRole('button', { name: 'Show 1 ended key' }).click();
  await page.getByText('Migration agent').waitFor();
  check(
    'Show N ended keys says it is open to assistive tech, and the same button hides them again',
    (await page
      .getByRole('button', { name: /^Hide ended keys?$/ })
      .getAttribute('aria-expanded')) === 'true',
  );
  check('the ended key is listed as expired', (await page.getByText('expired').count()) === 1);
  await shoot(page, '11h-keys-ended-shown');
  d1(
    `UPDATE credential SET expires_at = ${String(migration?.expires_at)} WHERE name = 'Migration agent'`,
  );
};

/** The waiting count after a delete, the Bin, and Activity. */
export const binAndActivity = async ({
  laptop,
  page,
  toPurged,
}: Pick<Run, 'laptop' | 'page' | 'toPurged'>) => {
  const keysWaitingNow = () =>
    page
      .getByRole('navigation', { name: 'Acme' })
      .getByRole('link', { name: /^Keys/ })
      .getByText(/\d waiting/)
      .count();
  await page
    .getByRole('navigation', { name: 'Acme' })
    .getByRole('link', { name: /^Keys/ })
    .getByText('1 waiting')
    .waitFor({ timeout: 5000 })
    .catch(() => undefined);
  check(
    'deleting an environment refreshes the waiting key changes',
    toPurged.json?.status === 'pending' && (await keysWaitingNow()) === 1,
  );
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
  await page
    .getByRole('navigation', { name: 'Acme' })
    .getByRole('link', { name: /^Keys/ })
    .getByText(/\d waiting/)
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => undefined);
  check(
    'a change naming an environment removed for good waits on nobody once it is gone',
    (await keysWaitingNow()) === 0,
  );
  await page.goto(toPurged.json.url);
  await page.getByRole('button', { name: 'Reject' }).waitFor();
  check(
    'its page says so and offers only Reject',
    (await page.getByText(/removed for good, so it cannot be approved/).count()) === 1 &&
      (await page.getByRole('button', { name: /^Approve/ }).count()) === 0,
  );
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  check(
    'and the terminal hears it was not approved',
    laptop.cli(['ask', 'wait', toPurged.json.id]).status === 4,
  );
  await page.goto(`${WEB}/orgs/acme/environments`);
  await environments.createEnvironment(page, 'app/old');
  await page.getByRole('link', { name: /app\/old/ }).waitFor();
  check('an environment deleted for good frees its name', true);

  await page.goto(`${WEB}/orgs/acme/activity`);
  await page.getByText('pasted').waitFor();
  check(
    'the activity shows requests approved and rejected, and names opened in the browser',
    (await page.getByText(/approved the request/).count()) >= 1 &&
      (await page.getByText(/rejected the request/).count()) === 3 &&
      (await page.getByText(/asked for a new environment/).count()) === 2 &&
      (await page.getByText(/rejected the request for a new environment/).count()) === 1 &&
      (await page.getByText('STRIPE_SECRET_KEY').count()) >= 1,
  );
  await shoot(page, '12-activity');
  await shootPhone(page, '12b-activity-phone');
  await account.accountPage(page);
};

/** A key belongs to one org, and an ask waits under its own org. */
export const keyOneOrg = async ({
  ciEnv,
  laptop,
  page,
}: Pick<Run, 'ciEnv' | 'laptop' | 'page'>) => {
  const across = laptop.cli([
    'ask',
    'access',
    '--read',
    'acme/app/production',
    '--read',
    'legacy/app/legacy',
    '--reason',
    'both orgs',
  ]);
  check(
    'an ask across two orgs is refused, and says to ask once per org',
    across.status === 2 && /once per org/.test(across.stderr),
  );
  const elsewhere = laptop.cli([
    'ask',
    'access',
    '--read',
    'legacy/app/legacy',
    '--reason',
    'read the legacy app',
  ]);
  check(
    'an ask links to its page under its own org',
    elsewhere.json?.url === `${WEB}/orgs/legacy/ask/access/${elsewhere.json?.id}`,
  );
  await page.goto(`${WEB}/orgs/legacy/keys`);
  await page.getByText('read the legacy app').waitFor();
  await page.getByRole('navigation', { name: 'Legacy Ltd' }).getByText('1 waiting').waitFor();
  await shoot(page, '13k-keys-other-org');
  await page.goto(`${WEB}/orgs/acme/environments`);
  await page.getByRole('link', { name: /acme\/app\/production/ }).waitFor();
  check(
    'an ask waits and is counted under its own org alone',
    (await page
      .getByRole('navigation', { name: 'Acme' })
      .getByText(/\d waiting/)
      .count()) === 0,
  );
  laptop.cli(['ask', 'cancel', elsewhere.json.id]);

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
      !varlockLoads(ciEnv, 'acme/app/production', { API_KEY: 'value-from-the-cli' }).isLoaded,
  );
  check('a logged-out computer is not logged in', laptop.cli(['env', 'list']).status === 3);
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('Acme’s keys show here').waitFor();
  await shoot(page, '14b-keys-empty');
  await account.noCliLogins(page);
  await page.goto(`${WEB}/orgs/acme/paste-links`);
  await page.getByText(/its paste link waits here/).waitFor();
  await shoot(page, '14c-paste-links-empty');
};

/** A request waiting under Keys, counted in the nav. */
export const keysRequestWaiting = async (page: Page) => {
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByRole('heading', { name: 'Waiting for you' }).waitFor();
  check(
    'a request waits under Keys, counted in the nav',
    (await page.getByText('run the migration').count()) === 1 &&
      (await page.getByRole('navigation', { name: 'Acme' }).getByText('1 waiting').count()) === 1,
  );
  await shoot(page, '08-keys-request-waiting');
  await shootPhone(page, '08-keys-request-waiting-phone');
};

/** Keys after a change was approved. */
export const keysAfterChange = async (page: Page) => {
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('Migration agent').waitFor();
  await shoot(page, '08h5-keys-after-change');
};

/** Paste links with one waiting. */
export const pasteLinks = async (page: Page) => {
  await page.goto(`${WEB}/orgs/acme/paste-links`);
  await page.getByText('to take payments').waitFor();
  await shoot(page, '09a-paste-links');
};

/** Keys with no key, in the dark scheme. */
export const keysEmptyDark = async (page: Page) => {
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByText('Acme’s keys show here').waitFor();
  await shoot(page, '16b-keys-empty-dark');
};
