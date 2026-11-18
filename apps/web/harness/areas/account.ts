import type { Page } from '@playwright/test';
import {
  check,
  followLink,
  keepRecoveryKey,
  keepsVaultOpen,
  PHONE,
  type Run,
  shooter,
  WEB,
  withPasskeys,
} from '../support.ts';
import * as environments from './environments.ts';

const { shoot, shootPhone } = shooter('account');

/** Sign-up by an email link and a passkey, the recovery key, and the first org. */
export const signUp = async ({ browser }: Pick<Run, 'browser'>) => {
  const { context, page } = await withPasskeys(browser);
  await page.goto(`${WEB}/signin`);
  await page.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  check(
    'the sign-in page says the price and names itself in its title',
    (await page.getByText('Free while in beta').count()) === 1 &&
      (await page.title()) === 'Sign in · baymutt',
  );
  await shoot(page, '01-sign-in');
  await shootPhone(page, '01c-sign-in-phone');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByRole('heading', { name: 'Create your account' }).waitFor();
  await shoot(page, '01b-sign-up');
  await followLink(page, '/signup', 'owner@example.test');
  await page.getByRole('heading', { name: 'Set up your vault' }).waitFor();
  await page.getByLabel('Your name').fill('Test owner');
  await shoot(page, '02-set-up');
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  const recoveryKey = await keepRecoveryKey(page);
  check(
    'an email link and a passkey make a vault, with a recovery key of thirteen groups',
    /^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/.test(recoveryKey),
  );
  await shoot(page, '03-recovery-key');
  await page.getByRole('button', { name: 'Continue' }).click();
  // No org yet: the Environments page makes one first.
  await page.getByLabel('Org name').fill('Acme');
  check(
    'a new org’s slug follows its name',
    (await page.getByLabel('Slug').inputValue()) === 'acme',
  );
  await page.getByLabel('Slug').fill('Not A Slug');
  const slugError = 'Use lower-case letters, digits and hyphens, up to 40.';
  check(
    'a refused slug is marked invalid and its error is the field’s description',
    (await page.getByLabel('Slug').getAttribute('aria-invalid')) === 'true' &&
      (await page.getByLabel('Slug').getAttribute('aria-describedby')) ===
        (await page.getByText(slugError).getAttribute('id')),
  );
  await shoot(page, '04a-new-org-slug-refused');
  await page.getByLabel('Slug').fill('acme');
  check(
    'a slug that is accepted is no longer marked invalid',
    (await page.getByLabel('Slug').getAttribute('aria-invalid')) !== 'true',
  );
  await shoot(page, '04-new-org');
  await page.getByRole('button', { name: 'Create org' }).click();
  await environments.environmentsEmpty(page, 'Acme');
  await shoot(page, '04-environments-empty');
  return { context, page, recoveryKey };
};

/** Deleting an org takes its keys, and Account knows at once. */
export const deleteOrg = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  await page.goto(`${WEB}/account#new-org`);
  await page.getByLabel('Org name').fill('Scratch');
  await page.getByRole('button', { name: 'Create org' }).click();
  await environments.environmentsEmpty(page, 'Scratch');
  await environments.createEnvironment(page, 'app/tmp');
  await page.getByRole('link', { name: /scratch\/app\/tmp/ }).waitFor();
  const scratchAsk = laptop.cli(['ask', 'access', '--read', 'scratch/app/tmp', '--reason', 'tmp']);
  await page.goto(scratchAsk.json.url);
  await page.getByRole('button', { name: 'Approve read' }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  laptop.cli(['ask', 'wait', scratchAsk.json.id]);
  await page.goto(`${WEB}/orgs/scratch/environments`);
  await page.getByRole('link', { name: /scratch\/app\/tmp/ }).click();
  await page.getByRole('button', { name: 'Delete environment' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete environment' }).click();
  await page.waitForURL(`${WEB}/orgs/scratch/environments`);
  await page.goto(`${WEB}/orgs/scratch/bin`);
  await page.getByRole('button', { name: 'scratch/app/tmp: delete for good' }).click();
  await page.getByRole('menuitem', { name: 'Delete for good' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete for good' }).click();
  await page.getByText(/stays here for 30 days/).waitFor();
  await page.goto(`${WEB}/account`);
  /** How many keys the Work laptop's revoke dialog says it asked for. */
  const keysAskedFor = async () => {
    await page.getByRole('button', { name: 'Work laptop: expiry, revoke' }).click();
    await page.getByRole('menuitem', { name: 'Revoke' }).click();
    const dialog = page.getByRole('alertdialog');
    const text = await dialog.innerText();
    await dialog.getByRole('button', { name: 'Keep key' }).click();
    await dialog.waitFor({ state: 'detached' });
    return Number(/so do(?:es)? the (\d+) keys?/.exec(text)?.[1] ?? 0);
  };
  const keysBefore = await keysAskedFor();
  await page.getByRole('button', { name: 'Scratch: delete org' }).click();
  await page.getByRole('menuitem', { name: 'Delete org' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete org' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'detached' });
  check(
    'deleting an org takes its key, and Account counts it gone without a reload',
    keysBefore > 0 && (await keysAskedFor()) === keysBefore - 1,
  );
  await page.goto(`${WEB}/orgs/acme/environments`);
  await page.getByRole('link', { name: /acme\/app\/production/ }).waitFor();
};

/** A second person, with a password and no passkey. */
export const secondPerson = async ({ browser }: Pick<Run, 'browser'>) => {
  const other = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const otherPage = await other.newPage();
  await followLink(otherPage, '/signup', 'sam@example.test');
  await otherPage.getByLabel('Your name').fill('Sam');
  await otherPage.getByLabel('Password', { exact: true }).fill('a long made-up password');
  await otherPage.getByLabel('Password again').fill('a long made-up password');
  await otherPage.getByRole('button', { name: 'Use this password' }).click();
  await keepRecoveryKey(otherPage);
  await otherPage.getByRole('button', { name: 'Continue' }).click();
  // No org of their own, and none of the first person's: the dashboard makes one first.
  await otherPage.getByRole('heading', { name: 'Create your first org' }).waitFor();
  check(
    'an email link and a password make a vault, and one account sees nothing of another',
    (await otherPage.getByRole('button', { name: /^Org: / }).count()) === 0,
  );
  await otherPage.goto(`${WEB}/account`);
  await otherPage.getByRole('heading', { name: 'Password' }).waitFor();
  await shoot(otherPage, '18-account-password');
  await otherPage.getByRole('button', { name: 'Sign out' }).first().click();
  await otherPage.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  check('signing out closes the vault in this browser', !(await keepsVaultOpen(otherPage)));
  await otherPage.getByLabel('Email').fill('sam');
  await otherPage.getByLabel('Password').fill('not the password at all');
  check(
    'Sign in waits for an email that looks like one',
    await otherPage.getByRole('button', { name: 'Sign in', exact: true }).isDisabled(),
  );
  await otherPage.getByLabel('Email').fill('sam@example.test');
  await otherPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await otherPage.getByRole('alert').waitFor();
  await shoot(otherPage, '18b-sign-in-error');
  await otherPage.getByLabel('Password').fill('a long made-up password');
  await otherPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await otherPage.getByRole('heading', { name: 'Create your first org' }).waitFor();
  check('email and password sign in and unlock; a wrong password does neither', true);
  await other.close();
};

/** Every way in lost: an email link, then the recovery key. */
export const recovery = async ({ browser, recoveryKey }: Pick<Run, 'browser' | 'recoveryKey'>) => {
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const freshPage = await fresh.newPage();
  await freshPage.goto(`${WEB}/signin`);
  await freshPage.getByRole('link', { name: 'Lost your password or passkey?' }).click();
  await freshPage.getByRole('heading', { name: 'Recover your account' }).waitFor();
  await shoot(freshPage, '17a-recover-email');
  await followLink(freshPage, '/recover', 'owner@example.test');
  await freshPage.getByRole('heading', { name: 'Recover your vault' }).waitFor();
  // Signed in by a link alone: it can look, and the store refuses any change.
  const refused = await freshPage.evaluate(async () => {
    const response = await fetch('/api/v1/account/recovery', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ recoveryWrappedDek: 'AAAA' }),
    });
    return response.status;
  });
  check('a session a link made changes nothing while the vault is locked', refused === 403);
  await freshPage.getByLabel('Recovery key').fill(recoveryKey.toLowerCase());
  await shoot(freshPage, '17-recover');
  await freshPage.getByRole('button', { name: 'Unlock my vault' }).click();
  const newKey = await keepRecoveryKey(freshPage);
  check('the recovery key opens the vault and is replaced', newKey !== recoveryKey);
  await freshPage.getByRole('button', { name: 'Continue' }).click();
  await freshPage.getByRole('button', { name: 'Set a password' }).click();
  await freshPage.getByLabel('New password', { exact: true }).fill('the replacement password');
  await freshPage.getByLabel('New password again').fill('the replacement password');
  await freshPage.getByRole('button', { name: 'Save password' }).click();
  await freshPage.getByRole('button', { name: 'Change password' }).waitFor();
  check('with the vault open again, a new password is set', true);
  await fresh.close();

  const spent = await browser.newContext({ colorScheme: 'dark', viewport: PHONE });
  const spentPage = await spent.newPage();
  await followLink(spentPage, '/recover', 'owner@example.test');
  await spentPage.getByLabel('Recovery key').fill(recoveryKey);
  await spentPage.getByRole('button', { name: 'Unlock my vault' }).click();
  await spentPage.getByRole('alert').waitFor();
  await shoot(spentPage, '17b-recover-error-dark-phone');
  check('the old recovery key no longer works', true);
  await spent.close();
};

/** CLI logins under Account. */
export const cliLogins = async (page: Page) => {
  await page.goto(`${WEB}/account`);
  await page.getByRole('heading', { name: 'CLI logins' }).waitFor();
  await page.getByText('Work laptop', { exact: true }).first().waitFor();
  await shoot(page, '11c-account-cli-logins');
  await shootPhone(page, '11d-account-cli-logins-phone');
  await page.getByRole('button', { name: 'Work laptop: expiry, revoke' }).click();
  await page.getByRole('menuitem', { name: 'Expiry' }).waitFor();
  check(
    'CLI logins are the account’s, under Account, with when each ends, and offer no access change',
    (await page.getByText(/expires in 90 days/).count()) === 1 &&
      (await page.getByRole('menuitem').allInnerTexts()).join(',') === 'Expiry,Revoke',
  );
  await page.getByRole('menuitem', { name: 'Expiry' }).click();
  const expiry = page.getByRole('dialog', { name: 'When should Work laptop expire?' });
  await expiry.getByRole('combobox', { name: 'Expires' }).click();
  await page.getByRole('option', { name: 'On a date…' }).click();
  check(
    'an Expiry dialog offers a date from tomorrow, and saves nothing until one is picked',
    (await expiry.getByLabel('Date').getAttribute('type')) === 'date' &&
      (await expiry.getByLabel('Date').getAttribute('min')) ===
        Temporal.Now.plainDateISO().add({ days: 1 }).toString() &&
      (await expiry.getByRole('button', { name: 'Save expiry' }).isDisabled()),
  );
  await shoot(page, '11c1-account-cli-login-expiry-date');
  await expiry.getByRole('button', { name: 'Cancel' }).click();
  await expiry.waitFor({ state: 'detached' });
};

/** The Account page. It is left with the new-org form open, which the next step fills. */
export const accountPage = async (page: Page) => {
  await page.goto(`${WEB}/account`);
  await page.getByRole('heading', { name: 'Passkeys' }).waitFor();
  // Every list loaded, the CLI logins' included: no skeleton in the shot.
  await page.getByText('Work laptop', { exact: true }).first().waitFor();
  check('Account names itself in its title', (await page.title()) === 'Account · baymutt');
  await shoot(page, '13-account');
  await page
    .getByRole('button', { name: /^Org: / })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'New org' }).click();
  await page.getByLabel('Org name').waitFor();
  check(
    'the org menu’s New org opens Account with the new-org form open',
    page.url() === `${WEB}/account#new-org` &&
      (await page.getByRole('button', { name: 'New org', exact: true }).count()) === 0,
  );
};

/** Account with no CLI login: its empty state and how an agent logs in. */
export const noCliLogins = async (page: Page) => {
  await page.goto(`${WEB}/account`);
  await page.getByText('A CLI login shows here once you approve the link it prints.').waitFor();
  await shoot(page, '14b2-account-no-cli-logins');
};
