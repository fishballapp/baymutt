/**
 * Drives the whole product in a real browser against `wrangler dev`: the dashboard with a virtual
 * passkey, the built CLI, and the built varlock plugin. Needs both dev servers up and the CLI and
 * plugin built:
 *
 *   pnpm -F @baymutt/worker-web dev        # :8790
 *   pnpm -F @baymutt/web dev               # :5183
 *   pnpm -F @baymutt/cli build && pnpm -F @baymutt/varlock-plugin build
 *   pnpm -F @baymutt/web drive
 *
 * Chromium only: its CDP virtual authenticator can do PRF headlessly. Screens land in
 * `apps/web/tmp/drive/`. Every value here is made up for the run.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';

const WEB = 'http://localhost:5183';
const shots = fileURLToPath(new URL('../tmp/drive', import.meta.url));
const cliBin = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
const pluginFile = fileURLToPath(
  new URL('../../../packages/varlock-plugin/dist/plugin.cjs', import.meta.url),
);
const varlockBin = fileURLToPath(
  new URL('../../worker-web/node_modules/.bin/varlock', import.meta.url),
);

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 860 };

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const check = (label: string, isTrue: boolean) => {
  if (!isTrue) fail(label);
  console.log(`✓ ${label}`);
};

/** A machine: its own key file and state, so nothing touches this Mac's keychain. */
const machine = (name: string) => {
  const home = mkdtempSync(join(tmpdir(), `baymutt-drive-${name}-`));
  const env = {
    ...process.env,
    BAYMUTT_URL: WEB,
    BAYMUTT_KEY_FILE: join(home, 'machine-key'),
    XDG_CONFIG_HOME: home,
  };
  return {
    home,
    env,
    /** Runs the CLI; answers its exit code and its JSON result. */
    cli: (args: readonly string[], stdin?: string) => {
      const run = spawnSync('node', [cliBin, ...args], { env, input: stdin, encoding: 'utf8' });
      return {
        status: run.status,
        stderr: run.stderr,
        json: /^[{[]/.test(run.stdout) ? JSON.parse(run.stdout) : undefined,
      };
    },
  };
};

/** A context whose passkeys live in a virtual authenticator with PRF. */
const withPasskeys = async (browser: Browser, colorScheme: 'light' | 'dark' = 'light') => {
  const context = await browser.newContext({ colorScheme, viewport: DESKTOP });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf: true,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page };
};

const shoot = async (page: Page, name: string) => {
  await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
};

/** The same screen at a phone's width, then back. */
const shootPhone = async (page: Page, name: string) => {
  await page.setViewportSize(PHONE);
  await shoot(page, name);
  await page.setViewportSize(DESKTOP);
};

/** Whether this browser still holds the key that keeps the vault open. */
const keepsVaultOpen = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<boolean>((resolve, reject) => {
        const opening = indexedDB.open('baymutt');
        opening.onerror = () => reject(opening.error);
        opening.onsuccess = () => {
          const counting = opening.result.transaction('unlock').objectStore('unlock').count();
          counting.onsuccess = () => resolve(counting.result > 0);
          counting.onerror = () => reject(counting.error);
        };
      }),
  );

/**
 * Asks for a link, from the sign-up page or the recovery page, and opens it. Local dev sends no
 * mail: the link's token is read from the Worker.
 */
const followLink = async (page: Page, from: '/signup' | '/recover', email: string) => {
  await page.goto(`${WEB}${from}`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /^Email me a link/ }).click();
  await page.getByRole('heading', { name: 'Check your inbox' }).waitFor();
  const answer = await fetch(`${WEB}/api/dev/magic-link?email=${encodeURIComponent(email)}`);
  const { token } = (await answer.json()) as { token: string };
  const landOn = from === '/signup' ? '/projects' : '/recover';
  await page.goto(`${WEB}/api/auth/magic-link/verify?token=${token}&callbackURL=${landOn}`);
};

const keepRecoveryKey = async (page: Page): Promise<string> => {
  await page.getByRole('heading', { name: 'Keep your recovery key' }).waitFor();
  const recoveryKey = (await page.locator('code').first().innerText()).trim();
  await page.getByRole('checkbox').check();
  return recoveryKey;
};

const main = async (browser: Browser) => {
  rmSync(shots, { recursive: true, force: true });
  mkdirSync(shots, { recursive: true });

  // --- sign up: an email link, then a passkey --------------------------------------------------
  const { context, page } = await withPasskeys(browser);
  await page.goto(`${WEB}/signin`);
  await page.getByRole('heading', { name: 'Sign in to baymutt' }).waitFor();
  await shoot(page, '01-sign-in');
  await shootPhone(page, '01c-sign-in-phone');
  await page.getByRole('link', { name: 'Create an account' }).click();
  await page.getByRole('heading', { name: 'Create your account' }).waitFor();
  await shoot(page, '01b-sign-up');
  await followLink(page, '/signup', 'jason@example.test');
  await page.getByRole('heading', { name: 'Set up your vault' }).waitFor();
  await page.getByLabel('Your name').fill('Jason');
  await shoot(page, '02-set-up');
  await page.getByRole('button', { name: 'Use a passkey' }).click();
  const recoveryKey = await keepRecoveryKey(page);
  check(
    'an email link and a passkey make a vault, with a recovery key of thirteen groups',
    /^([0-9A-Z]{4}-){12}[0-9A-Z]{4}$/.test(recoveryKey),
  );
  await shoot(page, '03-recovery-key');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByText('No projects yet').waitFor();
  await shoot(page, '04-projects-empty');

  // --- a project and a secret, from the dashboard -------------------------------------------
  await page.getByLabel('New project').fill('app/production');
  await page.getByRole('button', { name: 'Create project' }).click();
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByRole('heading', { name: 'app/production' }).waitFor();
  await shoot(page, '05-project-empty');
  await page.getByRole('button', { name: 'Add a secret' }).click();
  await page.getByLabel('Name').fill('SIGNING_KEY');
  await page.getByLabel('Value').fill('-----BEGIN KEY-----\nmade-up-line-two\n-----END KEY-----');
  await shoot(page, '06-add-secret');
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.getByText(/sealed · \d+ B · v1/).waitFor();
  check(
    'the dashboard seals a multi-line value and never shows it',
    !(await page.content()).includes('made-up-line-two'),
  );

  // --- pair a machine ------------------------------------------------------------------------
  const laptop = machine('laptop');
  const pending = laptop.cli(['pair', '--name', 'Jason’s MacBook', '--wait', '0']);
  check('`baymutt pair` prints a link and a code', pending.json?.status === 'pending');
  const signedOut = await browser.newContext({ viewport: DESKTOP });
  const signedOutPage = await signedOut.newPage();
  await signedOutPage.goto(pending.json.url);
  await signedOutPage.getByRole('heading', { name: 'Sign in to baymutt' }).waitFor();
  check(
    'a pairing link opened signed out asks to sign in and keeps its fragment',
    signedOutPage.url() === pending.json.url,
  );
  await signedOut.close();
  await page.goto(pending.json.url);
  await page.getByText(pending.json.code).waitFor();
  check('the pairing page shows the terminal’s code', true);
  await shoot(page, '07-pair');
  await page.getByRole('button', { name: 'The codes match: pair it' }).click();
  await page.getByRole('heading', { name: /is paired/ }).waitFor();
  check(
    '`baymutt pair` finishes once approved',
    laptop.cli(['pair', '--wait', '0']).json?.status === 'paired',
  );

  // --- the machine asks; the owner approves; the machine loads and writes ---------------------
  check(
    'a new machine sees no project',
    laptop.cli(['projects', 'list']).json?.projects.length === 0,
  );
  const asked = laptop.cli([
    'access',
    'request',
    'app/production',
    '--read',
    '--write',
    '--reason',
    'to deploy the worker',
  ]);
  check('the machine asks for access', asked.json?.status === 'pending');
  await page.goto(`${WEB}/requests`);
  await page.getByRole('button', { name: 'Approve read + write' }).waitFor();
  await shoot(page, '08-requests');
  await shootPhone(page, '08b-requests-phone');
  await page.getByRole('button', { name: 'Approve read + write' }).click();
  await page.getByText('Nothing is waiting on you').waitFor();
  await shoot(page, '08c-requests-empty');

  const set = laptop.cli(['set', 'app/production', 'API_KEY'], 'value-from-the-cli\n');
  check('the machine sets a value from stdin', set.json?.version === 1 && set.json?.length === 18);
  const generated = laptop.cli(['generate', 'app/production', 'SESSION_SECRET']);
  check('the machine generates a value without showing it', generated.json?.length === 43);

  // The varlock plugin loads the project and gives the values to a child process only.
  const schemaDir = mkdtempSync(join(tmpdir(), 'baymutt-drive-schema-'));
  copyFileSync(pluginFile, join(schemaDir, 'plugin.cjs'));
  writeFileSync(
    join(schemaDir, '.env.schema'),
    '# @defaultSensitive=true\n# @plugin(./plugin.cjs)\n# @initBaymutt()\n# @setValuesBulk(baymuttLoad("app/production"))\n# ---\nAPI_KEY=\nSIGNING_KEY=\nSESSION_SECRET=\n',
  );
  const probe =
    "const e=process.env;process.exit(e.API_KEY==='value-from-the-cli'&&e.SIGNING_KEY.split('\\n').length===3&&e.SESSION_SECRET.length===43?0:1)";
  const loaded = spawnSync(varlockBin, ['run', '--', 'node', '-e', probe], {
    cwd: schemaDir,
    env: laptop.env,
    encoding: 'utf8',
  });
  check(
    `varlock loads the project through the plugin${loaded.status === 0 ? '' : `: ${loaded.stderr}`}`,
    loaded.status === 0,
  );
  check(
    '`baymutt check` finds the schema satisfied',
    laptop.cli(['check', 'app/production', '--schema', join(schemaDir, '.env.schema')]).status ===
      0,
  );

  // --- a paste link, answered by someone with no session --------------------------------------
  const request = laptop.cli([
    'request',
    'app/production',
    'STRIPE_SECRET_KEY',
    '--reason',
    'to take payments',
    '--where',
    'Stripe dashboard, Developers, API keys',
  ]);
  check('`baymutt request` prints a paste link', typeof request.json?.url === 'string');
  const stranger = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const pastePage = await stranger.newPage();
  await pastePage.goto(request.json.url);
  await pastePage.getByLabel('Value').fill('sk_made_up_for_this_run');
  await shoot(pastePage, '09-paste-phone');
  await pastePage.getByRole('button', { name: 'Seal and save' }).click();
  await pastePage.getByRole('heading', { name: 'Saved' }).waitFor();
  await pastePage.reload();
  await pastePage.getByRole('heading', { name: 'This link cannot be used' }).waitFor();
  check('a paste link works once', true);
  await stranger.close();
  check(
    'the pasted value is the project’s',
    laptop.cli(['secrets', 'app/production']).json?.secrets.length === 4,
  );

  // --- a narrower machine for CI --------------------------------------------------------------
  const ciKey = join(laptop.home, 'ci-key');
  const created = laptop.cli([
    'machines',
    'create',
    '--name',
    'CI deploy',
    '--read',
    'app/production',
    '--',
    'sh',
    '-c',
    `cat > ${ciKey}`,
  ]);
  check('the machine makes a read-only one for CI', created.json?.grants?.[0]?.canWrite === false);

  // --- the dashboard after all that -----------------------------------------------------------
  await page.goto(`${WEB}/projects`);
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByText('STRIPE_SECRET_KEY').waitFor();
  await shoot(page, '10-project');
  await page.getByRole('button', { name: 'History' }).first().click();
  await page.getByText(/^v1$/).waitFor();
  await shoot(page, '10b-project-history');
  await shootPhone(page, '10c-project-phone');
  await page.goto(`${WEB}/projects`);
  await page.getByRole('link', { name: /app\/production/ }).waitFor();
  await shootPhone(page, '10d-projects-phone');
  await page.goto(`${WEB}/machines`);
  await page.getByText('CI deploy').waitFor();
  await shoot(page, '11-machines');
  await shootPhone(page, '11b-machines-phone');
  await page.goto(`${WEB}/activity`);
  await page.getByText('pasted').waitFor();
  await shoot(page, '12-activity');
  await shootPhone(page, '12b-activity-phone');
  await page.goto(`${WEB}/account`);
  await page.getByRole('heading', { name: 'Passkeys' }).waitFor();
  await shoot(page, '13-account');
  await shootPhone(page, '13b-account-phone');

  // The vault stays open across a reload, and a change still goes through.
  await page.reload();
  await page.getByRole('heading', { name: 'Passkeys' }).waitFor();
  check('a reload leaves the vault open', await keepsVaultOpen(page));

  // Revoking the laptop takes the CI machine with it.
  await page.goto(`${WEB}/machines`);
  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await shoot(page, '14-revoke');
  await page.getByRole('button', { name: 'Revoke machine' }).click();
  await page.getByText('No machines yet').waitFor();
  await shoot(page, '14b-machines-empty');
  check('a revoked machine is refused', laptop.cli(['projects', 'list']).status === 3);

  // --- dark, and a phone ----------------------------------------------------------------------
  // The same page: the virtual authenticator belongs to its target.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${WEB}/signin`);
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByText('STRIPE_SECRET_KEY').waitFor();
  await shoot(page, '15-project-dark');
  await page.setViewportSize(PHONE);
  await shoot(page, '16-project-dark-phone');
  await page.setViewportSize(DESKTOP);
  await page.goto(`${WEB}/machines`);
  await page.getByText('No machines yet').waitFor();
  await shoot(page, '16b-machines-empty-dark');
  await context.close();

  // --- a second person, with a password and no passkey ------------------------------------------
  const other = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const otherPage = await other.newPage();
  await followLink(otherPage, '/signup', 'sam@example.test');
  await otherPage.getByLabel('Your name').fill('Sam');
  await otherPage.getByLabel('Password', { exact: true }).fill('a long made-up password');
  await otherPage.getByLabel('Password again').fill('a long made-up password');
  await otherPage.getByRole('button', { name: 'Use this password' }).click();
  await keepRecoveryKey(otherPage);
  await otherPage.getByRole('button', { name: 'Continue' }).click();
  await otherPage.getByText('No projects yet').waitFor();
  check('an email link and a password make a vault, and one account sees nothing of another', true);
  await otherPage.goto(`${WEB}/account`);
  await otherPage.getByRole('heading', { name: 'Password' }).waitFor();
  await shoot(otherPage, '18-account-password');
  await otherPage.getByRole('button', { name: 'Sign out' }).first().click();
  await otherPage.getByRole('heading', { name: 'Sign in to baymutt' }).waitFor();
  check('signing out closes the vault in this browser', !(await keepsVaultOpen(otherPage)));
  await otherPage.getByLabel('Email').fill('sam@example.test');
  await otherPage.getByLabel('Password').fill('not the password at all');
  await otherPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await otherPage.getByRole('alert').waitFor();
  await shoot(otherPage, '18b-sign-in-error');
  await otherPage.getByLabel('Password').fill('a long made-up password');
  await otherPage.getByRole('button', { name: 'Sign in', exact: true }).click();
  await otherPage.getByRole('heading', { name: 'Projects' }).waitFor();
  check('email and password sign in and unlock; a wrong password does neither', true);
  await other.close();

  // --- the password and every passkey lost: an email link, then the recovery key ----------------
  const fresh = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const freshPage = await fresh.newPage();
  await freshPage.goto(`${WEB}/signin`);
  await freshPage.getByRole('link', { name: 'Lost your password or passkey?' }).click();
  await freshPage.getByRole('heading', { name: 'Recover your account' }).waitFor();
  await shoot(freshPage, '17a-recover-email');
  await followLink(freshPage, '/recover', 'jason@example.test');
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
  await freshPage.getByRole('button', { name: 'Open my vault' }).click();
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
  await followLink(spentPage, '/recover', 'jason@example.test');
  await spentPage.getByLabel('Recovery key').fill(recoveryKey);
  await spentPage.getByRole('button', { name: 'Open my vault' }).click();
  await spentPage.getByRole('alert').waitFor();
  await shoot(spentPage, '17b-recover-error-dark-phone');
  check('the old recovery key no longer works', true);
  await spent.close();

  for (const directory of [laptop.home, schemaDir])
    rmSync(directory, { recursive: true, force: true });
  console.log(`\nAll checks passed. Screens: ${shots}`);
};

const browser = await chromium.launch({ args: ['--mute-audio'] });
try {
  await main(browser);
} finally {
  await browser.close();
}
