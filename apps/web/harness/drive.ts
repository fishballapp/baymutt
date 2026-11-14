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
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

/** A made-up value long enough to wrap: one line of JSON. */
const LONG_VALUE = JSON.stringify({
  type: 'service_account',
  project_id: 'made-up-project',
  private_key_id: 'f'.repeat(40),
  client_email: 'deploy@made-up-project.example.test',
  token_uri: 'https://example.test/token',
  universe_domain: 'example.test',
});
const DESKTOP = { width: 1280, height: 860 };

const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

const check = (label: string, isTrue: boolean) => {
  if (!isTrue) fail(label);
  console.log(`✓ ${label}`);
};

/** A service account: its own key file and state, so nothing touches this Mac's keychain. */
const serviceAccount = (name: string) => {
  const home = mkdtempSync(join(tmpdir(), `baymutt-drive-${name}-`));
  const env = {
    ...process.env,
    BAYMUTT_URL: WEB,
    BAYMUTT_KEY_FILE: join(home, 'service-account-key'),
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
  const landOn = from === '/signup' ? '/environments' : '/recover';
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
  await shoot(page, '04-new-org');
  await page.getByRole('button', { name: 'Create org' }).click();
  await page.getByText('No environments in Acme yet').waitFor();
  await shoot(page, '04-environments-empty');

  // --- an environment and a secret, from the dashboard -------------------------------------------
  await page.getByLabel('New environment').fill('app/production');
  await page.getByRole('button', { name: 'Create environment' }).click();
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByRole('heading', { name: 'acme/app/production' }).waitFor();
  await shoot(page, '05-environment-empty');
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
  await page.getByRole('button', { name: 'Add a secret' }).click();
  await page.getByLabel('Name').fill('SERVICE_ACCOUNT_JSON');
  await page.getByLabel('Value').fill(LONG_VALUE);
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.getByText('SERVICE_ACCOUNT_JSON').waitFor();
  await shoot(page, '06a-environment-masked');

  // --- reveal, hide and copy: opened in this browser, logged by the store -------------------
  const signingRow = page.getByRole('listitem').filter({ hasText: 'SIGNING_KEY' });
  await signingRow.getByRole('button', { name: 'Reveal' }).click();
  await signingRow.getByText('made-up-line-two').waitFor();
  check(
    'Reveal opens a multi-line value in the browser, its lines kept',
    (await signingRow.locator('pre').innerText()) ===
      '-----BEGIN KEY-----\nmade-up-line-two\n-----END KEY-----',
  );
  const longRow = page.getByRole('listitem').filter({ hasText: 'SERVICE_ACCOUNT_JSON' });
  await longRow.getByRole('button', { name: 'Reveal' }).click();
  await longRow.getByRole('button', { name: 'Hide' }).waitFor();
  check(
    'a long value wraps inside its row',
    await longRow.evaluate(row => row.scrollWidth <= row.clientWidth),
  );
  await shoot(page, '06b-environment-revealed');
  await shootPhone(page, '06c-environment-revealed-phone');
  await signingRow.getByRole('button', { name: 'Hide' }).click();
  await longRow.getByRole('button', { name: 'Hide' }).click();
  check('Hide masks it again', !(await page.content()).includes('made-up-line-two'));
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  await signingRow.getByRole('button', { name: 'Copy' }).click();
  await signingRow.getByRole('button', { name: 'Copied' }).waitFor();
  check(
    'Copy copies a value without showing it',
    (await page.evaluate(() => navigator.clipboard.readText())) ===
      '-----BEGIN KEY-----\nmade-up-line-two\n-----END KEY-----' &&
      !(await page.content()).includes('made-up-line-two'),
  );
  await page.goto(`${WEB}/activity`);
  await page
    .getByText(/revealed or copied/)
    .first()
    .waitFor();
  check(
    'each reveal and copy is in the activity log',
    (await page.getByText(/revealed or copied/).count()) === 3,
  );
  await page.goBack();
  await page.getByRole('button', { name: 'Add a secret' }).waitFor();

  // --- log in: approving gives every environment -------------------------------------------------
  const laptop = serviceAccount('laptop');
  const pending = laptop.cli([
    'login',
    '--name',
    'Work laptop',
    '--description',
    'Coding agents on the work laptop',
    '--expires',
    '90d',
    '--wait',
    '0',
  ]);
  check('`baymutt login` prints a link and a code', pending.json?.status === 'pending');
  const signedOut = await browser.newContext({ viewport: DESKTOP });
  const signedOutPage = await signedOut.newPage();
  await signedOutPage.goto(pending.json.url);
  await signedOutPage.getByRole('heading', { name: 'Sign in to baymutt' }).waitFor();
  check(
    'an approval link opened signed out asks to sign in and keeps its fragment',
    signedOutPage.url() === pending.json.url,
  );
  await signedOut.close();
  await page.goto(pending.json.url);
  await page.getByText(pending.json.code).waitFor();
  check('the approval page shows the terminal’s code', true);
  check(
    'the approval page shows the terminal’s description and the expiry it asked for',
    (await page.getByText('Coding agents on the work laptop').count()) === 1 &&
      (await page.getByLabel('Expires').inputValue()) === 'kept',
  );
  check(
    'the approval page says a login reads and writes every environment',
    (await page.getByText(/read and write every environment/).count()) === 1,
  );
  await shoot(page, '07-approve');
  await shootPhone(page, '07b-approve-phone');
  await page.getByRole('button', { name: 'The codes match: approve it' }).click();
  await page.getByRole('heading', { name: /is approved/ }).waitFor();
  check(
    '`baymutt login` finishes once approved',
    laptop.cli(['login', '--wait', '0']).json?.status === 'loggedIn',
  );
  check(
    'a login approved after an environment was made reads and writes it',
    laptop
      .cli(['environments', 'list'])
      .json?.environments.some(
        (environment: { name: string; canRead: boolean; canWrite: boolean }) =>
          environment.name === 'app/production' && environment.canRead && environment.canWrite,
      ) === true,
  );

  const set = laptop.cli(['set', 'acme/app/production', 'API_KEY'], 'value-from-the-cli\n');
  check(
    'the service account sets a value from stdin',
    set.json?.version === 1 && set.json?.length === 18,
  );
  const generated = laptop.cli(['generate', 'acme/app/production', 'SESSION_SECRET']);
  check('the service account generates a value without showing it', generated.json?.length === 43);

  // The varlock plugin loads the environment and gives the values to a child process only.
  const schemaDir = mkdtempSync(join(tmpdir(), 'baymutt-drive-schema-'));
  copyFileSync(pluginFile, join(schemaDir, 'plugin.cjs'));
  writeFileSync(
    join(schemaDir, '.env.schema'),
    '# @defaultSensitive=true\n# @plugin(./plugin.cjs)\n# @initBaymutt()\n# @setValuesBulk(baymuttLoad("acme/app/production"))\n# ---\nAPI_KEY=\nSIGNING_KEY=\nSESSION_SECRET=\n',
  );
  const probe =
    "const e=process.env;process.exit(e.API_KEY==='value-from-the-cli'&&e.SIGNING_KEY.split('\\n').length===3&&e.SESSION_SECRET.length===43?0:1)";
  const loaded = spawnSync(varlockBin, ['run', '--', 'node', '-e', probe], {
    cwd: schemaDir,
    env: laptop.env,
    encoding: 'utf8',
  });
  check(
    `varlock loads the environment through the plugin${loaded.status === 0 ? '' : `: ${loaded.stderr}`}`,
    loaded.status === 0,
  );
  check(
    '`baymutt check` finds the schema satisfied',
    laptop.cli(['check', 'acme/app/production', '--schema', join(schemaDir, '.env.schema')])
      .status === 0,
  );

  // --- a paste link, answered by someone with no session --------------------------------------
  const pasteLink = laptop.cli([
    'paste-link',
    'acme/app/production',
    'STRIPE_SECRET_KEY',
    '--reason',
    'to take payments',
    '--where',
    'Stripe dashboard, Developers, API keys',
  ]);
  check('`baymutt paste-link` prints a paste link', typeof pasteLink.json?.url === 'string');
  const stranger = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const pastePage = await stranger.newPage();
  await pastePage.goto(pasteLink.json.url);
  await pastePage.getByLabel('Value').fill('sk_made_up_for_this_run');
  await shoot(pastePage, '09-paste-phone');
  await pastePage.getByRole('button', { name: 'Seal and save' }).click();
  await pastePage.getByRole('heading', { name: 'Saved' }).waitFor();
  await pastePage.reload();
  await pastePage.getByRole('heading', { name: 'This link cannot be used' }).waitFor();
  check('a paste link works once', true);
  await stranger.close();
  check(
    'the pasted value is the environment’s',
    laptop.cli(['secrets', 'acme/app/production']).json?.secrets.length === 5,
  );

  // --- a second login; an environment one login makes reaches the other through the dashboard ------
  const server = serviceAccount('server');
  const serverPending = server.cli(['login', '--name', 'Build server', '--wait', '0']);
  await page.goto(serverPending.json.url);
  await page.getByText(serverPending.json.code).waitFor();
  await page.getByRole('button', { name: 'The codes match: approve it' }).click();
  await page.getByRole('heading', { name: /is approved/ }).waitFor();
  server.cli(['login', '--wait', '0']);
  laptop.cli(['environments', 'create', 'acme/app/staging']);
  laptop.cli(['set', 'acme/app/staging', 'API_KEY'], 'staging-value');
  const waiting = server.cli(['secrets', 'acme/app/staging']);
  check(
    'another login waits for the dashboard on an environment a login made, and is told so',
    waiting.status === 4 && waiting.stderr.includes('open the baymutt dashboard'),
  );
  await page.goto(`${WEB}/environments`);
  await page.getByRole('link', { name: /app\/staging/ }).waitFor();
  let toppedUp = false;
  for (let attempt = 0; attempt < 20 && !toppedUp; attempt++) {
    toppedUp = server.cli(['secrets', 'acme/app/staging']).status === 0;
    if (!toppedUp) await page.waitForTimeout(250);
  }
  check('opening the dashboard grants it to every login', toppedUp);

  await page.getByLabel('New environment').fill('app/preview');
  await page.getByRole('button', { name: 'Create environment' }).click();
  await page.getByRole('link', { name: /app\/preview/ }).waitFor();
  laptop.cli(['set', 'acme/app/preview', 'API_KEY'], 'preview-value');
  check(
    'an environment made in the dashboard reaches every login at once',
    laptop.cli(['secrets', 'acme/app/preview']).status === 0 &&
      server.cli(['secrets', 'acme/app/preview']).status === 0,
  );

  // --- a narrower service account for CI --------------------------------------------------------------
  const ciKey = join(laptop.home, 'ci-key');
  const created = laptop.cli([
    'service-accounts',
    'create',
    '--name',
    'CI deploy',
    '--description',
    'Deploys app/production from CI',
    '--expires',
    '30d',
    '--read',
    'acme/app/production',
    '--',
    'sh',
    '-c',
    `cat > ${ciKey}`,
  ]);
  check(
    'the login makes a read-only one for CI, with a description and an expiry',
    created.json?.grants?.[0]?.canWrite === false &&
      created.json?.description === 'Deploys app/production from CI' &&
      typeof created.json?.expiresAt === 'number',
  );
  const ci = serviceAccount('ci');
  const ciEnv = { ...ci.env, BAYMUTT_KEY: readFileSync(ciKey, 'utf8') };
  const ciAsked = spawnSync('node', [cliBin, 'secrets', 'acme/app/staging'], {
    env: ciEnv,
    encoding: 'utf8',
  });
  check('the CI service account reaches nothing it was not handed', ciAsked.status === 5);

  /** Whether the CI service account, with the key it was made with, loads `API_KEY` of an environment through varlock. */
  const ciLoads = (environment: string, value: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'baymutt-drive-ci-'));
    copyFileSync(pluginFile, join(dir, 'plugin.cjs'));
    writeFileSync(
      join(dir, '.env.schema'),
      `# @defaultSensitive=true\n# @plugin(./plugin.cjs)\n# @initBaymutt()\n# @setValuesBulk(baymuttLoad("${environment}"))\n# ---\nAPI_KEY=\n`,
    );
    return (
      spawnSync(
        varlockBin,
        [
          'run',
          '--',
          'node',
          '-e',
          `process.exit(process.env.API_KEY===${JSON.stringify(value)}?0:1)`,
        ],
        { cwd: dir, env: ciEnv, encoding: 'utf8' },
      ).status === 0
    );
  };
  const ciId: string = created.json.id;
  const handedOn = laptop.cli(['service-accounts', 'access', ciId, '--read', 'acme/app/staging']);
  check(
    'its login hands it another environment from the CLI, and it loads it with the key it already had',
    handedOn.status === 0 && ciLoads('acme/app/staging', 'staging-value'),
  );
  check(
    'it cannot change its own access',
    spawnSync('node', [cliBin, 'service-accounts', 'access', ciId, '--read', 'acme/app/preview'], {
      env: ciEnv,
      encoding: 'utf8',
    }).status !== 0 && !ciLoads('acme/app/preview', 'preview-value'),
  );

  // A secret an agent deleted: it is in the bin, not in the environment's list.
  laptop.cli(['set', 'acme/app/production', 'OLD_TOKEN'], 'old-value');
  const binned = laptop.cli(['delete', 'acme/app/production', 'OLD_TOKEN']);
  check(
    'a deleted secret goes to the bin, and the CLI lists it there',
    typeof binned.json?.purgeAt === 'number' &&
      laptop.cli(['bin', 'list']).json?.secrets?.[0]?.name === 'OLD_TOKEN',
  );

  // --- the dashboard after all that -----------------------------------------------------------
  await page.goto(`${WEB}/environments`);
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByText('STRIPE_SECRET_KEY').waitFor();
  await shoot(page, '10-environment');
  check(
    'the environment lists no deleted secret',
    (await page.getByText('OLD_TOKEN').count()) === 0,
  );
  await page.getByRole('button', { name: 'History' }).first().click();
  await page.getByText(/^v1$/).waitFor();
  await shoot(page, '10b-environment-history');
  await shootPhone(page, '10c-environment-phone');
  await page.goto(`${WEB}/environments`);
  await page.getByRole('link', { name: /app\/production/ }).waitFor();
  await page.setViewportSize(PHONE);
  const navWraps = await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link')
    .evaluateAll(links =>
      links.some(
        link => link.scrollWidth > link.clientWidth || link.getBoundingClientRect().height > 40,
      ),
    );
  check('the phone navigation keeps every label on one line', !navWraps);
  await page.setViewportSize(DESKTOP);
  await shoot(page, '10d-environments');
  await shootPhone(page, '10d-environments-phone');
  await page.goto(`${WEB}/service-accounts`);
  await page.getByText('CI deploy').waitFor();
  check(
    'the list tells a CLI login from a service account, and shows descriptions and expiry',
    (await page.getByRole('img', { name: 'CLI login' }).count()) === 2 &&
      (await page.getByRole('img', { name: 'Service account' }).count()) === 1 &&
      (await page.getByText('Deploys app/production from CI').count()) === 1 &&
      (await page.getByText(/expires in \d+ days/).count()) === 2,
  );
  await shoot(page, '11-service-accounts');
  await shootPhone(page, '11b-service-accounts-phone');

  // The owner hands the CI service account an environment from the dashboard, under its old key.
  await page.getByRole('button', { name: 'Access' }).click();
  const accessDialog = page.getByRole('alertdialog');
  await accessDialog.waitFor();
  await accessDialog
    .getByRole('listitem')
    .filter({ hasText: 'acme/app/preview' })
    .getByLabel('read')
    .check();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '11e-access.png') });
  await page.setViewportSize(PHONE);
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '11f-access-phone.png') });
  await page.setViewportSize(DESKTOP);
  await page.getByRole('button', { name: 'Save access' }).click();
  await accessDialog.waitFor({ state: 'hidden' });
  await page.getByText('acme/app/preview', { exact: true }).waitFor();
  check(
    'the owner hands it an environment from the dashboard, and it loads it with the key it already had',
    ciLoads('acme/app/preview', 'preview-value'),
  );
  await shoot(page, '11g-service-accounts-after-access');
  await page.getByRole('button', { name: 'Expiry' }).last().click();
  await page.getByLabel('Expires').selectOption('never');
  await page.getByRole('alertdialog').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '11c-expiry.png') });
  await page.getByRole('button', { name: 'Save expiry' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  await page.getByText(/expires in 30 days/).waitFor({ state: 'detached' });
  check(
    'the owner changes when a service account expires',
    (await page.getByText(/expires in \d+ days/).count()) === 1,
  );
  await shoot(page, '11d-service-accounts-after-expiry');
  // --- the bin ---------------------------------------------------------------------------------
  laptop.cli(['environments', 'create', 'acme/app/old']);
  await page.goto(`${WEB}/environments`);
  await page.getByRole('link', { name: /app\/old/ }).click();
  await page.getByRole('button', { name: 'Delete environment' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete environment' }).click();
  await page.waitForURL(`${WEB}/environments`);
  await page.getByRole('link', { name: 'Bin' }).first().click();
  await page.getByText('OLD_TOKEN').waitFor();
  await page.getByText('acme/app/old').waitFor();
  await shoot(page, '11g-bin');
  await shootPhone(page, '11h-bin-phone');
  const secretRow = page.getByRole('listitem').filter({ hasText: 'OLD_TOKEN' });
  await secretRow.getByRole('button', { name: 'Restore' }).click();
  await page.getByText('OLD_TOKEN').waitFor({ state: 'detached' });
  check(
    'the owner restores a secret from the bin, and the CLI loads it again',
    laptop
      .cli(['secrets', 'acme/app/production'])
      .json?.secrets?.some((secret: { name: string }) => secret.name === 'OLD_TOKEN') === true,
  );
  const environmentRow = page.getByRole('listitem').filter({ hasText: 'acme/app/old' });
  await environmentRow.getByRole('button', { name: 'Delete for good' }).click();
  await page.getByRole('alertdialog').waitFor();
  await page.waitForTimeout(300);
  await shoot(page, '11i-bin-delete-for-good');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete for good' }).click();
  await page.getByText('The bin is empty').waitFor();
  check(
    'the owner deletes an environment in the bin for good, and its name is free again',
    laptop.cli(['environments', 'create', 'acme/app/old']).status === 0,
  );

  await page.goto(`${WEB}/activity`);
  await page.getByText('pasted').waitFor();
  await shoot(page, '12-activity');
  await shootPhone(page, '12b-activity-phone');
  await page.goto(`${WEB}/account`);
  await page.getByRole('heading', { name: 'Passkeys' }).waitFor();
  await shoot(page, '13-account');
  await shootPhone(page, '13b-account-phone');

  // A second org, made in the dashboard: the CLI has none to make, and the picker scopes
  // Environments to it.
  check(
    'the CLI has no orgs command: orgs are made in the dashboard',
    laptop.cli(['orgs', 'list']).status !== 0,
  );
  await page.goto(`${WEB}/account`);
  await page.getByLabel('Org name').fill('Globex Corp');
  await page.getByLabel('Slug').fill('globex');
  await page.getByRole('button', { name: 'Create org' }).click();
  await page.getByRole('main').getByText('Globex Corp').waitFor();
  await shoot(page, '13e-account-orgs');
  await page.goto(`${WEB}/environments`);
  await page.getByText('No environments in Globex Corp yet').waitFor();
  check('a new org is the one the picker shows', true);
  await shoot(page, '13c-environments-other-org');
  await shootPhone(page, '13d-environments-other-org-phone');
  const picker = page.getByLabel('Org', { exact: true });
  await picker.selectOption({ label: 'Acme' });
  await page.getByRole('link', { name: /acme\/app\/production/ }).waitFor();

  // The vault stays open across a reload, and a change still goes through.
  await page.goto(`${WEB}/account`);
  await page.reload();
  await page.getByRole('heading', { name: 'Passkeys' }).waitFor();
  check('a reload leaves the vault open', await keepsVaultOpen(page));

  // Logging the laptop out takes the CI service account with it.
  const loggedOut = laptop.cli(['logout']);
  check(
    '`baymutt logout` revokes the login and what it made',
    loggedOut.json?.status === 'loggedOut' && loggedOut.json?.revoked.length === 2,
  );
  check(
    'a logged-out computer is not logged in',
    laptop.cli(['environments', 'list']).status === 3,
  );
  await page.goto(`${WEB}/service-accounts`);
  await page.getByText('Build server').waitFor();
  await page.getByRole('button', { name: 'Revoke' }).first().click();
  await shoot(page, '14-revoke');
  await page.getByRole('button', { name: 'Revoke service account' }).click();
  await page.getByText('No service accounts yet').waitFor();
  await shoot(page, '14b-service-accounts-empty');
  check('a revoked service account is refused', server.cli(['environments', 'list']).status === 3);
  await page.goto(`${WEB}/paste-links`);
  await page.getByText('Nothing is waiting on you').waitFor();
  await shoot(page, '14c-paste-links-empty');
  await shootPhone(page, '14d-paste-links-empty-phone');

  // --- dark, and a phone ----------------------------------------------------------------------
  // The same page: the virtual authenticator belongs to its target.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto(`${WEB}/signin`);
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByText('STRIPE_SECRET_KEY').waitFor();
  await shoot(page, '15-environment-dark');
  await page.setViewportSize(PHONE);
  await shoot(page, '16-environment-dark-phone');
  await page.setViewportSize(DESKTOP);
  await page.goto(`${WEB}/service-accounts`);
  await page.getByText('No service accounts yet').waitFor();
  await shoot(page, '16b-service-accounts-empty-dark');
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
  // No org of their own, and none of the first person's: the Environments page makes one first.
  await otherPage.getByLabel('Org name').waitFor();
  check(
    'an email link and a password make a vault, and one account sees nothing of another',
    (await otherPage.getByLabel('Org', { exact: true }).count()) === 0,
  );
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
  await otherPage.getByRole('heading', { name: 'Environments' }).waitFor();
  check('email and password sign in and unlock; a wrong password does neither', true);
  await other.close();

  // --- the password and every passkey lost: an email link, then the recovery key ----------------
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
  await followLink(spentPage, '/recover', 'owner@example.test');
  await spentPage.getByLabel('Recovery key').fill(recoveryKey);
  await spentPage.getByRole('button', { name: 'Open my vault' }).click();
  await spentPage.getByRole('alert').waitFor();
  await shoot(spentPage, '17b-recover-error-dark-phone');
  check('the old recovery key no longer works', true);
  await spent.close();

  for (const directory of [laptop.home, server.home, ci.home, schemaDir])
    rmSync(directory, { recursive: true, force: true });
  console.log(`\nAll checks passed. Screens: ${shots}`);
};

const browser = await chromium.launch({ args: ['--mute-audio'] });
try {
  await main(browser);
} finally {
  await browser.close();
}
