// The environments and secrets area's steps, and the moves other areas' steps make on its pages.
import type { Page } from '@playwright/test';
import { askPlan, check, DESKTOP, LONG_VALUE, PHONE, type Run, shooter, WEB } from '../support.ts';

const { shoot, shootPhone } = shooter('environments');

/** How long a revealed value stays shown: 30 seconds, as DESIGN.md says. */
const REVEAL_MS = 30_000;

const SIGNING_VALUE = '-----BEGIN KEY-----\nmade-up-line-two\n-----END KEY-----';

/** Waits for an org's Environments with no environment in it. */
export const environmentsEmpty = (page: Page, orgName: string) =>
  page.getByText(`${orgName}’s environments show here.`).waitFor();

/** On Environments: opens New environment unless it is open, and creates one. The form stays open. */
export const createEnvironment = async (page: Page, name: string) => {
  const form = page.getByRole('form', { name: 'New environment' });
  if (!(await form.isVisible())) {
    await page.getByRole('button', { name: 'New environment' }).click();
  }
  await form.getByLabel('Name', { exact: true }).fill(name);
  await form.getByRole('button', { name: 'Create environment' }).click();
};

/** On an environment: adds a secret and waits for its row. */
export const addSecret = async (page: Page, name: string, value: string) => {
  await page.getByRole('button', { name: 'Add a secret' }).click();
  await page.getByLabel('Name', { exact: true }).fill(name);
  await page.getByLabel('Value', { exact: true }).fill(value);
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.getByRole('button', { name: `Reveal ${name}` }).waitFor();
};

const secretRow = (page: Page, name: string) =>
  page.locator('li.row-secret').filter({ has: page.getByText(name, { exact: true }) });

/** A revealed value hides itself after 30 seconds and when the tab is hidden, on a fake clock. */
const revealHidesItself = async ({ context, page }: Pick<Run, 'context' | 'page'>) => {
  const timed = await context.newPage();
  await timed.clock.install();
  await timed.goto(page.url());
  const row = secretRow(timed, 'SIGNING_KEY');
  await row.getByRole('button', { name: 'Reveal SIGNING_KEY' }).click();
  await row.getByText('made-up-line-two').waitFor();
  await timed.clock.fastForward(REVEAL_MS - 1000);
  const isShownBefore = (await row.getByText('made-up-line-two').count()) === 1;
  await timed.clock.fastForward(2000);
  await row.getByRole('button', { name: 'Reveal SIGNING_KEY' }).waitFor();
  check(
    'a revealed value hides itself 30 seconds after it was revealed, with nothing counting down',
    isShownBefore && !(await timed.content()).includes('made-up-line-two'),
  );
  await row.getByRole('button', { name: 'Reveal SIGNING_KEY' }).click();
  await row.getByText('made-up-line-two').waitFor();
  await timed.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await row.getByRole('button', { name: 'Reveal SIGNING_KEY' }).waitFor();
  check(
    'a revealed value hides itself at once when the tab is hidden',
    !(await timed.content()).includes('made-up-line-two'),
  );
  await timed.close();
};

/** The first environment and secret from the dashboard; reveal, hide, copy, and the auto-hide. */
export const firstSecret = async ({ context, page }: Pick<Run, 'context' | 'page'>) => {
  await createEnvironment(page, 'app/production');
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByRole('heading', { name: 'acme/app/production' }).waitFor();
  await shoot(page, '05-environment-empty');
  await page.getByRole('button', { name: 'Add a secret' }).click();
  await page.getByLabel('Name', { exact: true }).fill('SIGNING_KEY');
  await page.getByLabel('Value', { exact: true }).fill(SIGNING_VALUE);
  await shoot(page, '06-add-secret');
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.locator('li.row-secret.just-written').waitFor();
  await page.locator('li.just-written').waitFor({ state: 'detached' });
  check('a saved secret’s row flashes once, and the flash goes', true);
  check(
    'the dashboard seals a multi-line value and never shows it',
    !(await page.content()).includes('made-up-line-two'),
  );
  // A save the store fails once (a dropped connection, a 503) is tried again by the same button,
  // with nothing edited: the failure shows, but does not hold the form back.
  // A secret's name is sealed in its address, so any write is matched: the next one fails.
  const writeOnce = (url: URL) => /\/environments\/[^/]+\/secrets\/[^/]+$/.test(url.pathname);
  await page.route(writeOnce, route =>
    route.request().method() === 'PUT' ? route.fulfill({ status: 503 }) : route.fallback(),
  );
  await page.getByRole('button', { name: 'Add a secret' }).click();
  await page.getByLabel('Name', { exact: true }).fill('SERVICE_ACCOUNT_JSON');
  await page.getByLabel('Value', { exact: true }).fill(LONG_VALUE);
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page
    .getByRole('alert')
    .filter({ hasText: /went wrong/ })
    .waitFor();
  await page.unroute(writeOnce);
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.getByRole('button', { name: 'Reveal SERVICE_ACCOUNT_JSON' }).waitFor();
  check('a save the store failed is tried again by the same button, with nothing edited', true);
  await page.locator('li.just-written').waitFor({ state: 'detached' });
  await shoot(page, '06a-environment-masked');

  const signingRow = secretRow(page, 'SIGNING_KEY');
  const nameBefore = await signingRow.locator('.name').boundingBox();
  await signingRow.getByRole('button', { name: 'Reveal SIGNING_KEY' }).click();
  await signingRow.getByText('made-up-line-two').waitFor();
  check(
    'Reveal opens a multi-line value in place, its lines kept, and nothing else on the row moves',
    (await signingRow.locator('.value').innerText()) === SIGNING_VALUE &&
      JSON.stringify(await signingRow.locator('.name').boundingBox()) ===
        JSON.stringify(nameBefore),
  );
  const longRow = secretRow(page, 'SERVICE_ACCOUNT_JSON');
  await longRow.getByRole('button', { name: 'Reveal SERVICE_ACCOUNT_JSON' }).click();
  await longRow.getByRole('button', { name: 'Hide SERVICE_ACCOUNT_JSON' }).waitFor();
  check(
    'a long value wraps inside its row',
    await longRow.evaluate(row => row.scrollWidth <= row.clientWidth),
  );
  await shoot(page, '06b-environment-revealed');
  await shootPhone(page, '06c-environment-revealed-phone');
  await signingRow.getByRole('button', { name: 'Hide SIGNING_KEY' }).click();
  await longRow.getByRole('button', { name: 'Hide SERVICE_ACCOUNT_JSON' }).click();
  check('Hide masks it again', !(await page.content()).includes('made-up-line-two'));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await signingRow.getByRole('button', { name: 'Copy SIGNING_KEY' }).click();
  await signingRow.locator('.icon-btn.copied').waitFor();
  check(
    'Copy copies a value without showing it, and says so',
    (await page.evaluate(() => navigator.clipboard.readText())) === SIGNING_VALUE &&
      !(await page.content()).includes('made-up-line-two') &&
      (await signingRow.getByText('SIGNING_KEY copied').count()) === 1,
  );
  const environmentUrl = page.url();
  await page.goto(`${WEB}/orgs/acme/activity`);
  await page
    .getByText(/revealed or copied/)
    .first()
    .waitFor();
  check(
    'each reveal and copy is in the activity log',
    (await page.getByText(/revealed or copied/).count()) === 3,
  );
  check(
    'the activity names the secret and the environment, opened in the browser',
    (await page.getByText('acme/app/production').count()) > 0 &&
      (await page.getByText('SIGNING_KEY').count()) > 0,
  );
  await page.goto(environmentUrl);
  await revealHidesItself({ context, page });
};

/** An environment page, its history, Environments, and deleting an environment. */
export const environmentPage = async ({
  keyId,
  laptop,
  page,
}: Pick<Run, 'keyId' | 'laptop' | 'page'>) => {
  await page.goto(`${WEB}/orgs/acme/environments`);
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByText('STRIPE_SECRET_KEY').waitFor();
  await addSecret(page, 'OLD_TOKEN', 'old-value');
  await page.locator('li.just-written').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'OLD_TOKEN: replace, history, delete' }).click();
  await page.getByRole('menuitem', { name: 'Delete' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete secret' }).click();
  await secretRow(page, 'OLD_TOKEN').waitFor({ state: 'detached' });
  check(
    'a secret the owner deletes goes to the bin, and the CLI login lists it there by name',
    laptop.cli(['bin', 'list']).json?.secrets?.[0]?.name === 'OLD_TOKEN',
  );
  const shownNames = await page.locator('li.row-secret > .name').allInnerTexts();
  check(
    'the environment lists its secrets by name, sorted in the browser, and no deleted one',
    JSON.stringify(shownNames) ===
      JSON.stringify(shownNames.toSorted((a, b) => a.localeCompare(b))) &&
      !shownNames.includes('OLD_TOKEN') &&
      shownNames.includes('SIGNING_KEY'),
  );
  check(
    'it lists the keys that read it, each with its end, and none that writes',
    (await page.locator('li.row-reach').count()) > 0 &&
      (await page.locator('li.row-reach .status').first().innerText()).includes('expires') &&
      (await page.locator('li.row-reach .access').getByText('write').count()) === 0,
  );
  await shoot(page, '10-environment');
  await page
    .getByRole('button', { name: /: replace, history, delete$/ })
    .first()
    .click();
  await page.getByRole('menuitem', { name: 'History' }).click();
  await page.getByText(/^v1$/).waitFor();
  check(
    'History opens under its row, and its menu then hides it',
    (await page.getByRole('button', { name: /: replace, hide history, delete$/ }).count()) === 1,
  );
  await shoot(page, '10b-environment-history');
  await shootPhone(page, '10c-environment-phone');
  await page.goto(`${WEB}/orgs/acme/environments`);
  await page.getByRole('link', { name: /app\/production/ }).waitFor();
  await page.setViewportSize(PHONE);
  const navWraps = await page
    .getByRole('navigation', { name: 'Acme' })
    .getByRole('link')
    .evaluateAll(links =>
      links.some(link => {
        // A tab is its glyph over its label: the label must stay one line, inside the tab.
        const label = link.querySelector('span');
        if (label === null) return true;
        return link.scrollWidth > link.clientWidth || label.getClientRects().length > 1;
      }),
    );
  check('the phone navigation keeps every label on one line', !navWraps);
  await page.setViewportSize(DESKTOP);
  await shoot(page, '10d-environments');
  await shootPhone(page, '10d-environments-phone');

  await createEnvironment(page, 'app/old');
  await page.getByRole('link', { name: /app\/old/ }).click();
  // A plan's change waits for it while it goes to the bin, and then for good.
  const toPurged = askPlan(laptop, {
    reason: 'one last look',
    steps: [{ type: 'change', key: keyId, read: ['acme/app/old'] }],
  });
  await page.getByRole('button', { name: 'Delete environment' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete environment' }).click();
  await page.waitForURL(`${WEB}/orgs/acme/environments`);
  return { toPurged };
};

/** An environment in the dark scheme, desktop and phone. */
export const environmentDark = async (page: Page) => {
  await page.goto(`${WEB}/signin`);
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByText('STRIPE_SECRET_KEY').waitFor();
  await shoot(page, '15-environment-dark');
  await page.setViewportSize(PHONE);
  await shoot(page, '16-environment-dark-phone');
  await page.setViewportSize(DESKTOP);
};
