/**
 * Drives the whole product in a real browser against `wrangler dev`: the dashboard with a virtual
 * passkey, the built CLI, and the built varlock plugin. Needs both dev servers up on a fresh local
 * database, and the CLI and plugin built:
 *
 *   pnpm -F @baymutt/worker-web dev        # :8790
 *   pnpm -F @baymutt/web dev               # :5183
 *   pnpm -F @baymutt/cli build && pnpm -F @baymutt/varlock-plugin build
 *   pnpm -F @baymutt/web drive
 *
 * Chromium only: its CDP virtual authenticator can do PRF headlessly. Screens land in
 * `apps/web/tmp/drive/`. Every value here is made up for the run.
 *
 * One org is put back the way 0.7 stored it (names as written, no names key) with SQL on the local
 * D1 through `wrangler d1 execute --local`, to show the dashboard sealing it and its service
 * account loading throughout.
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Browser, chromium, type Page } from '@playwright/test';

const WEB = 'http://localhost:5183';
const shots = fileURLToPath(new URL('../tmp/drive', import.meta.url));
const cliBin = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
const pluginFile = fileURLToPath(
  new URL('../../../packages/varlock-plugin/dist/plugin.cjs', import.meta.url),
);
const workerDir = fileURLToPath(new URL('../../worker-web/', import.meta.url));
const varlockBin = join(workerDir, 'node_modules/.bin/varlock');
const wranglerBin = join(workerDir, 'node_modules/.bin/wrangler');

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

/** A computer with a CLI login: its own key file and state, so nothing touches this Mac's keychain. */
const computer = (name: string) => {
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
    /** Runs the CLI as the CLI login, or as the key in `keyFile`; answers its exit code and its JSON result. */
    cli: (
      args: readonly string[],
      { stdin, keyFile }: { stdin?: string; keyFile?: string } = {},
    ) => {
      const run = spawnSync('node', [cliBin, ...args], {
        env: keyFile === undefined ? env : { ...env, BAYMUTT_KEY_FILE: keyFile },
        input: stdin,
        encoding: 'utf8',
      });
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

/**
 * Whether `varlock run`, through the built plugin, loads `environment` with the key `env` names
 * and hands the child exactly `expected`.
 */
const varlockLoads = (
  env: NodeJS.ProcessEnv,
  environment: string,
  expected: Readonly<Record<string, string>>,
) => {
  const dir = mkdtempSync(join(tmpdir(), 'baymutt-drive-schema-'));
  copyFileSync(pluginFile, join(dir, 'plugin.cjs'));
  writeFileSync(
    join(dir, '.env.schema'),
    `# @defaultSensitive=true\n# @plugin(./plugin.cjs)\n# @initBaymutt()\n# @setValuesBulk(baymuttLoad("${environment}"))\n# ---\n${Object.keys(
      expected,
    )
      .map(name => `${name}=\n`)
      .join('')}`,
  );
  const probe = `const e=process.env,x=${JSON.stringify(expected)};process.exit(Object.keys(x).every(k=>e[k]===x[k])?0:1)`;
  const run = spawnSync(varlockBin, ['run', '--', 'node', '-e', probe], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });
  rmSync(dir, { recursive: true, force: true });
  return { isLoaded: run.status === 0, stderr: run.stderr };
};

/** SQL on the local D1 the dev Worker uses. Answers the rows of the last statement. */
const d1 = (sql: string): ReadonlyArray<Record<string, unknown>> => {
  const file = join(mkdtempSync(join(tmpdir(), 'baymutt-drive-sql-')), 'run.sql');
  writeFileSync(file, sql);
  const run = spawnSync(
    wranglerBin,
    ['d1', 'execute', 'baymutt', '--local', '--json', '--file', file],
    { cwd: workerDir, encoding: 'utf8' },
  );
  rmSync(dirname(file), { recursive: true, force: true });
  if (run.status !== 0) fail(`wrangler d1 execute failed: ${run.stderr}${run.stdout}`);
  const results = JSON.parse(run.stdout) as ReadonlyArray<{ results: Record<string, unknown>[] }>;
  return results.at(-1)?.results ?? [];
};

const sqlText = (text: string) => `'${text.replaceAll("'", "''")}'`;

const MINUTE_MS = 60_000;

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
  check(
    'the activity names the secret and the environment, opened in the browser',
    (await page.getByText('acme/app/production').count()) > 0 &&
      (await page.getByText('SIGNING_KEY').count()) > 0,
  );

  // --- log in: approving lists names and holds no environment ------------------------------------
  const laptop = computer('laptop');
  const pending = laptop.cli([
    'auth',
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
  check('`baymutt auth login` prints a link and a code', pending.json?.status === 'pending');
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
  check(
    'the approval page shows the terminal’s description and the expiry it asked for',
    (await page.getByText('Coding agents on the work laptop').count()) === 1 &&
      (await page.getByLabel('Expires').inputValue()) === 'kept',
  );
  check(
    'the approval page says a login lists names and opens no value',
    (await page.getByText(/list the names of your orgs, environments and secrets/).count()) === 1 &&
      (await page.getByText(/opens no value and writes none/).count()) === 1,
  );
  await shoot(page, '07-approve');
  await shootPhone(page, '07b-approve-phone');
  await page.getByRole('button', { name: 'The codes match: approve it' }).click();
  await page.getByRole('heading', { name: /is approved/ }).waitFor();
  check(
    '`baymutt auth login` finishes once approved',
    laptop.cli(['auth', 'login', '--wait', '0']).json?.status === 'loggedIn',
  );
  const listed = laptop.cli(['env', 'list']).json?.environments ?? [];
  const production = listed.find(
    (environment: { name: string }) => environment.name === 'app/production',
  );
  check(
    'the CLI login lists the environment by its name, and holds neither read nor write',
    production !== undefined && !production.canRead && !production.canWrite,
  );
  check(
    'the CLI login lists the secret names',
    laptop
      .cli(['secret', 'list', 'acme/app/production'])
      .json?.secrets?.some((secret: { name: string }) => secret.name === 'SIGNING_KEY') === true,
  );
  check(
    'the CLI login loads nothing through varlock',
    !varlockLoads(laptop.env, 'acme/app/production', { SIGNING_KEY: 'x' }).isLoaded,
  );
  check(
    'the CLI login writes nothing',
    laptop.cli(['secret', 'set', 'acme/app/production', 'API_KEY'], { stdin: 'nope' }).status === 4,
  );

  // --- baymutt ask access: approved with a shorter end, the key file loads through varlock --------------
  const asked = laptop.cli([
    'ask',
    'access',
    '--read',
    'acme/app/production',
    '--write',
    'acme/app/production',
    '--reason',
    'run the migration',
    '--expires',
    '1h',
    '--name',
    'Migration agent',
  ]);
  check(
    '`baymutt ask access` prints the request’s link and returns',
    asked.status === 0 &&
      asked.json?.status === 'pending' &&
      asked.json?.url.includes('/ask/access/'),
  );
  await page.goto(`${WEB}/keys`);
  await page.getByRole('heading', { name: 'Requests' }).waitFor();
  check(
    'a request waits under Keys, counted in the nav',
    (await page.getByText('run the migration').count()) === 1 &&
      (await page
        .getByRole('navigation', { name: 'Main' })
        .getByText('1 waiting for you')
        .count()) === 1,
  );
  await shoot(page, '08-keys-request-waiting');
  await page.getByRole('link', { name: 'Review' }).click();
  await page.getByRole('heading', { name: 'Approve this request?' }).waitFor();
  check('the Review link opens the request’s own page', page.url() === asked.json.url);
  check(
    'the request page shows the login, the reason, the environment and what was asked for',
    (await page.getByText('Work laptop').count()) > 0 &&
      (await page.getByText('“run the migration”').count()) === 1 &&
      (await page.getByText('acme/app/production').count()) === 1 &&
      (await page.getByText('read + write').count()) === 1 &&
      (await page.getByLabel('Ends').inputValue()) === `${60 * MINUTE_MS}`,
  );
  await page.getByLabel('Ends').selectOption(`${15 * MINUTE_MS}`);
  check(
    'the request page says approving a key kept in a file makes an agent key',
    (await page.getByText(/approving makes an agent key/).count()) === 1,
  );
  await shoot(page, '08b-request');
  await shootPhone(page, '08c-request-phone');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  await shoot(page, '08d-request-approved');
  const approved = laptop.cli(['ask', 'wait', asked.json.id]);
  check(
    'the terminal gets a key file, which ends when the owner chose and not when it asked',
    approved.json?.status === 'approved' &&
      typeof approved.json?.keyFile === 'string' &&
      Math.abs(approved.json.expiresAt - (Date.now() + 15 * MINUTE_MS)) < 2 * MINUTE_MS,
  );
  const agentKey: string = approved.json.keyFile;
  const set = laptop.cli(['secret', 'set', 'acme/app/production', 'API_KEY'], {
    stdin: 'value-from-the-cli\n',
    keyFile: agentKey,
  });
  check(
    'the approved key sets a value from stdin',
    set.json?.version === 1 && set.json?.length === 18,
  );
  const generated = laptop.cli(['secret', 'generate', 'acme/app/production', 'SESSION_SECRET'], {
    keyFile: agentKey,
  });
  check('the approved key generates a value without showing it', generated.json?.length === 43);
  const agentEnv = { ...laptop.env, BAYMUTT_KEY_FILE: agentKey };
  const loaded = varlockLoads(agentEnv, 'acme/app/production', {
    API_KEY: 'value-from-the-cli',
    SIGNING_KEY: '-----BEGIN KEY-----\nmade-up-line-two\n-----END KEY-----',
  });
  check(
    `the key file loads the environment through the plugin under varlock run${loaded.isLoaded ? '' : `: ${loaded.stderr}`}`,
    loaded.isLoaded,
  );
  await page.goto(asked.json.url);
  await page.getByRole('heading', { name: 'Already approved' }).waitFor();
  check('an answered request says so', true);

  // --- an environment request: the owner creates it, then a request reaches it ----------------
  check(
    '`baymutt ask access` names only an environment that exists',
    laptop.cli(['ask', 'access', '--write', 'acme/app/staging', '--reason', 'set up staging'])
      .status !== 0,
  );
  const creating = laptop.cli([
    'ask',
    'create-environment',
    'acme/app/staging',
    '--reason',
    'set up staging',
  ]);
  check(
    '`baymutt ask create-environment` prints the environment request’s link and returns',
    creating.status === 0 &&
      creating.json?.status === 'pending' &&
      creating.json?.url === `${WEB}/ask/create-environment/${creating.json?.id}`,
  );
  await page.goto(`${WEB}/environments`);
  await page.getByRole('heading', { name: 'Requests' }).waitFor();
  check(
    'an environment request waits at the top of Environments, counted on its nav item',
    (await page.getByText('set up staging').count()) === 1 &&
      (await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: /^Environments/ })
        .getByText('1 waiting for you')
        .count()) === 1,
  );
  await shoot(page, '08e-environments-request-waiting');
  await page.getByRole('link', { name: 'Review' }).click();
  await page.getByRole('heading', { name: 'Create this environment?' }).waitFor();
  check('the Review link opens the environment request’s page', page.url() === creating.json.url);
  check(
    'the environment request page shows the login, the opened name and the reason',
    (await page.getByText('Work laptop').count()) > 0 &&
      (await page.getByText('acme/app/staging', { exact: true }).count()) === 1 &&
      (await page.getByText('“set up staging”').count()) === 1,
  );
  await shoot(page, '08e1-environment-request');
  await shootPhone(page, '08e2-environment-request-phone');
  await page.getByRole('button', { name: 'Create environment' }).click();
  await page.getByRole('heading', { name: 'Created', exact: true }).waitFor();
  await shoot(page, '08e3-environment-request-created');
  const created = laptop.cli(['ask', 'wait', creating.json.id]);
  check(
    '`baymutt ask wait` says the owner created it',
    created.status === 0 &&
      created.json?.status === 'approved' &&
      created.json?.environment === 'acme/app/staging',
  );
  check(
    'the environment has the id the request asked for, and nobody but the owner reaches it',
    laptop
      .cli(['env', 'list'])
      .json?.environments?.some(
        (environment: { id: string; name: string; canRead: boolean; canWrite: boolean }) =>
          environment.id === creating.json.id &&
          environment.name === 'app/staging' &&
          !environment.canRead &&
          !environment.canWrite,
      ) === true,
  );
  await page.goto(creating.json.url);
  await page.getByRole('heading', { name: 'Already created' }).waitFor();
  check('an answered environment request says so', true);
  const staging = laptop.cli([
    'ask',
    'access',
    '--write',
    'acme/app/staging',
    '--read',
    'acme/app/staging',
    '--reason',
    'set up staging',
  ]);
  await page.goto(staging.json.url);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  const stagingKey: string = laptop.cli(['ask', 'wait', staging.json.id]).json?.keyFile;
  check(
    'a request for the new environment, once approved, writes it',
    laptop.cli(['secret', 'set', 'acme/app/staging', 'API_KEY'], {
      stdin: 'staging-value',
      keyFile: stagingKey,
    }).status === 0,
  );
  check(
    'and loads it through varlock',
    varlockLoads({ ...laptop.env, BAYMUTT_KEY_FILE: stagingKey }, 'acme/app/staging', {
      API_KEY: 'staging-value',
    }).isLoaded,
  );
  await page.goto(`${WEB}/environments`);
  await page.getByRole('link', { name: /acme\/app\/staging/ }).waitFor();
  check('the new environment is listed in the dashboard by its name', true);

  const scratch = laptop.cli([
    'ask',
    'create-environment',
    'acme/app/scratch',
    '--reason',
    'somewhere to try things',
  ]);
  await page.goto(scratch.json.url);
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  await shoot(page, '08e4-environment-request-rejected');
  check(
    'a rejected environment request ends the terminal’s wait, and creates nothing',
    laptop.cli(['ask', 'wait', scratch.json.id]).status === 4 &&
      laptop
        .cli(['env', 'list'])
        .json?.environments?.every(
          (environment: { name: string }) => environment.name !== 'app/scratch',
        ) === true,
  );
  await page.goto(`${WEB}/ask/create-environment/${crypto.randomUUID()}`);
  await page.getByRole('heading', { name: 'No request at this link' }).waitFor();
  check('a missing environment request says so', true);
  // --- a rejected request ---------------------------------------------------------------------
  const rejected = laptop.cli([
    'ask',
    'access',
    '--read',
    'acme/app/production',
    '--reason',
    'read everything, just in case',
  ]);
  await page.goto(rejected.json.url);
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  await shoot(page, '08f-request-rejected');
  const rejectedWait = laptop.cli(['ask', 'wait', rejected.json.id]);
  check('a rejected request ends the terminal’s wait with no key', rejectedWait.status === 4);
  await page.goto(`${WEB}/ask/access/${crypto.randomUUID()}`);
  await page.getByRole('heading', { name: 'No request at this link' }).waitFor();
  await shoot(page, '08g-request-missing');
  check('a missing request says so', true);

  // --- baymutt ask change: the same key gains, gives back, and gets a new end -------------------
  const agentId: string = asked.json.id;
  const changeKey = (args: readonly string[]) => laptop.cli(['ask', 'change', agentId, ...args]);
  const loadsWithAgentKey = (environment: string) =>
    laptop
      .cli(['env', 'list'], { keyFile: agentKey })
      .json?.environments?.some(
        (listed: { address: string; canRead: boolean }) =>
          listed.address === environment && listed.canRead,
      ) === true;
  const agentEnds = laptop
    .cli(['key', 'list'])
    .json?.keys?.find((key: { id: string }) => key.id === agentId)?.expiresAt;

  const moving = changeKey([
    '--read',
    'acme/app/staging',
    '--give-back',
    'acme/app/production',
    '--expires',
    '1d',
    '--reason',
    'the migration moves on to staging',
  ]);
  check(
    '`baymutt ask change` prints the change’s link and returns',
    moving.status === 0 &&
      moving.json?.status === 'pending' &&
      moving.json?.key === agentId &&
      moving.json?.url === `${WEB}/ask/change/${moving.json?.id}`,
  );
  await page.goto(`${WEB}/keys`);
  await page.getByRole('heading', { name: 'Requests' }).waitFor();
  check(
    'a key change waits under Keys, counted in the nav',
    (await page.getByText(/asks to change/).count()) === 1 &&
      (await page
        .getByRole('navigation', { name: 'Main' })
        .getByText('1 waiting for you')
        .count()) === 1,
  );
  await page.getByRole('link', { name: 'Review' }).click();
  await page.getByRole('heading', { name: 'Approve this change?' }).waitFor();
  check('the Review link opens the change’s own page', page.url() === moving.json.url);
  check(
    'the change page shows what the key holds now, what it adds, what it gives back, and the end asked for',
    (await page.getByText('“the migration moves on to staging”').count()) === 1 &&
      (await page.getByRole('heading', { name: 'What it holds now' }).count()) === 1 &&
      (await page.getByRole('heading', { name: 'What it adds' }).count()) === 1 &&
      (await page.getByRole('heading', { name: 'What it gives back' }).count()) === 1 &&
      (await page.getByText('acme/app/staging').count()) === 1 &&
      (await page.getByText('acme/app/production').count()) === 2 &&
      (await page.getByLabel('Ends').inputValue()) === `${24 * 60 * MINUTE_MS}`,
  );
  await shoot(page, '08h1-key-change-new-end');
  await shootPhone(page, '08h2-key-change-new-end-phone');
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  const movingWait = laptop.cli(['ask', 'wait', moving.json.id]);
  check(
    'a rejected change ends the wait, and the key holds what it held',
    movingWait.status === 4 &&
      loadsWithAgentKey('acme/app/production') &&
      !loadsWithAgentKey('acme/app/staging'),
  );

  const moved = changeKey([
    '--read',
    'acme/app/staging',
    '--give-back',
    'acme/app/production',
    '--reason',
    'the migration moves on to staging',
  ]);
  await page.goto(moved.json.url);
  await page.getByRole('heading', { name: 'Approve this change?' }).waitFor();
  check(
    'a change that asks for no new end keeps the key’s own by default',
    (await page.getByLabel('Ends').inputValue()) === 'keep',
  );
  await shoot(page, '08h3-key-change');
  await shootPhone(page, '08h4-key-change-phone');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  const movedWait = laptop.cli(['ask', 'wait', moved.json.id]);
  check(
    'a change that adds and gives back, once approved, is the same key file holding the new set, with its end kept',
    movedWait.status === 0 &&
      movedWait.json?.keyFile === agentKey &&
      movedWait.json?.expiresAt === agentEnds &&
      loadsWithAgentKey('acme/app/staging') &&
      !loadsWithAgentKey('acme/app/production'),
  );
  check(
    'and it loads the environment it gained through varlock',
    varlockLoads({ ...laptop.env, BAYMUTT_KEY_FILE: agentKey }, 'acme/app/staging', {
      API_KEY: 'staging-value',
    }).isLoaded,
  );

  const adding = changeKey(['--read-write', 'acme/app/production', '--reason', 'one more check']);
  await page.goto(adding.json.url);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  check(
    'a change that only adds, once approved, loads both',
    laptop.cli(['ask', 'wait', adding.json.id]).status === 0 &&
      loadsWithAgentKey('acme/app/staging') &&
      loadsWithAgentKey('acme/app/production'),
  );
  await page.goto(`${WEB}/keys`);
  await page.getByText('Migration agent').waitFor();
  await shoot(page, '08h5-keys-after-change');

  const givingBack = changeKey([
    '--give-back',
    'acme/app/staging',
    '--reason',
    'done with staging',
  ]);
  check(
    'giving back alone takes effect at once, with no approval',
    givingBack.status === 0 &&
      givingBack.json?.status === 'applied' &&
      !loadsWithAgentKey('acme/app/staging') &&
      loadsWithAgentKey('acme/app/production'),
  );

  const extending = changeKey(['--expires', '2h', '--reason', 'the migration runs long']);
  await page.goto(extending.json.url);
  await page.getByRole('heading', { name: 'Approve this change?' }).waitFor();
  check(
    'a new end alone waits for the owner, and offers what was asked',
    extending.json?.status === 'pending' &&
      (await page.getByLabel('Ends').inputValue()) === `${120 * MINUTE_MS}` &&
      (await page.getByText('It gains nothing.').count()) === 1,
  );
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  const extended = laptop.cli(['ask', 'wait', extending.json.id]);
  check(
    'the new end counts from the approval',
    extended.status === 0 &&
      Math.abs(extended.json.expiresAt - (Date.now() + 120 * MINUTE_MS)) < 2 * MINUTE_MS,
  );
  await page.goto(`${WEB}/ask/change/${crypto.randomUUID()}`);
  await page.getByRole('heading', { name: 'No change at this link' }).waitFor();
  check('a missing key change says so', true);

  // --- a name that does not open: nothing is approved or pasted for it ---------------------------
  const unopenedAsk = laptop.cli([
    'ask',
    'access',
    '--read',
    'acme/app/production',
    '--reason',
    'read production',
  ]);
  const unopenedPaste = laptop.cli([
    'ask',
    'paste-link',
    'acme/app/production',
    'UNOPENED_KEY',
    '--reason',
    'to check names',
    '--where',
    'nowhere',
  ]);
  if (unopenedAsk.json === undefined || unopenedPaste.json === undefined) {
    fail(
      `the request and paste link for a name that does not open: ${unopenedAsk.stderr}${unopenedPaste.stderr}`,
    );
  }
  // The store files production's sealed name as staging's: it opens, but not to its own index.
  const [productionRow] = d1(
    `SELECT id, sealed_name FROM environment WHERE id = ${sqlText(String(production?.id))}`,
  );
  await page.goto('about:blank');
  d1(`UPDATE environment SET sealed_name =
        (SELECT sealed_name FROM environment WHERE id = ${sqlText(creating.json.id)})
      WHERE id = ${sqlText(String(productionRow?.id))}`);
  await page.goto(unopenedAsk.json.url);
  await page.getByText('acme/name does not open').waitFor();
  check(
    'a request naming an environment whose name does not open says so, and cannot be approved',
    (await page.getByText(/so this request cannot be approved/).count()) === 1 &&
      (await page.getByRole('button', { name: 'Approve', exact: true }).isDisabled()),
  );
  await shoot(page, '08i-request-name-unopened');
  await page.goto(unopenedPaste.json.url);
  await page.getByLabel('Value').fill('never-sent');
  check(
    'a paste link whose environment’s name does not open says so, and saves nothing',
    (await page.getByText(/nothing can be saved for it/).count()) === 1 &&
      (await page.getByRole('button', { name: 'Seal and save' }).isDisabled()),
  );
  await shoot(page, '09e-paste-name-unopened');
  await page.goto('about:blank');
  d1(`UPDATE environment SET sealed_name = ${sqlText(String(productionRow?.sealed_name))}
        WHERE id = ${sqlText(String(productionRow?.id))};
      UPDATE paste_link SET status = 'cancelled' WHERE id = ${sqlText(unopenedPaste.json.id)};`);
  await page.goto(unopenedAsk.json.url);
  await page.getByText('acme/app/production', { exact: true }).waitFor();
  check(
    'once the name opens again, the request can be approved',
    !(await page.getByRole('button', { name: 'Approve', exact: true }).isDisabled()),
  );
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();

  // --- a paste link, answered by the signed-in owner alone -------------------------------------
  const pasteLink = laptop.cli([
    'ask',
    'paste-link',
    'acme/app/production',
    'STRIPE_SECRET_KEY',
    '--reason',
    'to take payments',
    '--where',
    'Stripe dashboard, Developers, API keys',
  ]);
  check(
    'the CLI login makes a paste link that carries nothing but its id',
    pasteLink.json?.url === `${WEB}/paste/${pasteLink.json?.id}`,
  );
  const stranger = await browser.newContext({ viewport: { width: 420, height: 800 } });
  const strangerPage = await stranger.newPage();
  await strangerPage.goto(pasteLink.json.url);
  await strangerPage.getByRole('heading', { name: 'Sign in to baymutt' }).waitFor();
  check(
    'a paste link opened signed out asks to sign in where it is',
    strangerPage.url() === pasteLink.json.url &&
      (await strangerPage.getByLabel('Value').count()) === 0,
  );
  await shoot(strangerPage, '09-paste-signed-out-phone');
  await stranger.close();
  await page.goto(`${WEB}/paste-links`);
  await page.getByText('to take payments').waitFor();
  await shoot(page, '09a-paste-links');
  // The store points the link at another name after the page showed it: nothing is sealed to that.
  const decoy = laptop.cli([
    'ask',
    'paste-link',
    'acme/app/production',
    'DECOY_KEY',
    '--reason',
    'decoy',
    '--where',
    'nowhere',
  ]);
  if (decoy.json === undefined) fail(`the decoy paste link: ${decoy.stderr}`);
  const [shownLink] = d1(
    `SELECT name, sealed_name FROM paste_link WHERE id = ${sqlText(pasteLink.json.id)}`,
  );
  await page.getByRole('link', { name: 'Paste value' }).first().click();
  await page.getByRole('heading', { name: /Paste STRIPE_SECRET_KEY/ }).waitFor();
  d1(`UPDATE paste_link SET (name, sealed_name) =
        (SELECT name, sealed_name FROM paste_link WHERE id = ${sqlText(decoy.json.id)})
      WHERE id = ${sqlText(pasteLink.json.id)}`);
  await page.getByLabel('Value').fill('sk_made_up_for_this_run');
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.getByText(/names something other than what this page shows/).waitFor();
  check(
    'a paste link that names something else by the time it is saved is refused',
    d1(`SELECT status FROM paste_link WHERE id = ${sqlText(pasteLink.json.id)}`)[0]?.status ===
      'pending' &&
      laptop
        .cli(['secret', 'list', 'acme/app/production'])
        .json?.secrets?.every((secret: { name: string }) => secret.name !== 'DECOY_KEY') === true,
  );
  d1(`UPDATE paste_link SET name = ${sqlText(String(shownLink?.name))},
        sealed_name = ${sqlText(String(shownLink?.sealed_name))}
      WHERE id = ${sqlText(pasteLink.json.id)};
      UPDATE paste_link SET status = 'cancelled' WHERE id = ${sqlText(decoy.json.id)};`);
  await page.reload();
  await page.getByRole('heading', { name: /Paste STRIPE_SECRET_KEY/ }).waitFor();
  await page.getByLabel('Value').fill('sk_made_up_for_this_run');
  await shoot(page, '09b-paste');
  await page.setViewportSize({ width: 420, height: 800 });
  await shoot(page, '09c-paste-phone');
  await page.setViewportSize(DESKTOP);
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.getByRole('heading', { name: 'Saved' }).waitFor();
  await shoot(page, '09d-paste-saved');
  await page.reload();
  await page.getByRole('heading', { name: 'This link cannot be used' }).waitFor();
  check('a paste link works once', true);
  check(
    'the pasted value is the environment’s, under its name',
    varlockLoads(agentEnv, 'acme/app/production', {
      STRIPE_SECRET_KEY: 'sk_made_up_for_this_run',
    }).isLoaded,
  );

  // --- a key for CI: piped into a command once approved -------------------------------------------
  const ciKey = join(laptop.home, 'ci-key');
  const piped = laptop.cli([
    'ask',
    'access',
    '--read',
    'acme/app/production',
    '--reason',
    'CI: deploy',
    '--name',
    'CI deploy',
    '--',
    'sh',
    '-c',
    `cat > ${ciKey}`,
  ]);
  await page.goto(piped.json.url);
  await page.getByText(`sh -c 'cat > ${ciKey}'`).waitFor();
  check(
    'the request page shows the command the key goes to, and no end as asked',
    (await page.getByLabel('Ends').inputValue()) === 'never' &&
      (await page.getByText(/With no end, it works until you revoke it/).count()) === 1,
  );
  check(
    'the request page says approving a key piped into a command makes a service account',
    (await page.getByText(/approving makes a service account/).count()) === 1,
  );
  await shoot(page, '08h-request-piped');
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  const delivered = laptop.cli(['ask', 'wait', piped.json.id]);
  check(
    'the key is piped into the command once approved, and kept nowhere else',
    delivered.json?.piped === true && delivered.json?.expiresAt === null,
  );
  const ci = computer('ci');
  const ciEnv = { ...ci.env, BAYMUTT_KEY: readFileSync(ciKey, 'utf8').trim() };
  check(
    'the CI key loads its environment under varlock run',
    varlockLoads(ciEnv, 'acme/app/production', { API_KEY: 'value-from-the-cli' }).isLoaded,
  );
  check(
    'the CI key reaches nothing it was not given',
    spawnSync('node', [cliBin, 'secret', 'list', 'acme/app/staging'], {
      env: ciEnv,
      encoding: 'utf8',
    }).status === 5,
  );

  // A service account its login asked for is changed the same way, and its page says what it is.
  const ciChange = laptop.cli([
    'ask',
    'change',
    piped.json.id,
    '--read',
    'acme/app/staging',
    '--reason',
    'CI deploys staging too',
  ]);
  await page.goto(ciChange.json.url);
  await page.getByRole('heading', { name: 'Approve this change?' }).waitFor();
  check(
    '`baymutt ask change` asks for a service account too, and its page names it as one',
    ciChange.json?.status === 'pending' &&
      (await page.getByText(/asks to change the service account/).count()) === 1,
  );
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();

  // --- the Keys page, and access changed by the owner ------------------------------------------
  await page.goto(`${WEB}/keys`);
  await page.getByText('CI deploy').waitFor();
  await shoot(page, '11-keys');
  check(
    'the list tells CLI logins, service accounts and agent keys apart, with when each ends',
    (await page.getByRole('img', { name: 'CLI login' }).count()) === 1 &&
      (await page.getByRole('img', { name: 'Service account' }).count()) === 1 &&
      (await page.getByRole('img', { name: 'Agent key' }).count()) === 2 &&
      (await page.getByText('never expires').count()) === 1 &&
      // The migration agent's end, as its key change set it.
      (await page.getByText(/expires in 2 hours/).count()) === 1 &&
      (await page.getByText(/expires in (1 hour|5[0-9] minutes)/).count()) === 1 &&
      (await page.getByText(/expires in 90 days/).count()) === 1,
  );
  check(
    'a CLI login offers no access change',
    (await page
      .getByRole('listitem')
      .filter({ hasText: 'Work laptop' })
      .filter({ has: page.getByRole('img', { name: 'CLI login' }) })
      .getByRole('button', { name: 'Access' })
      .count()) === 0,
  );
  await shootPhone(page, '11b-keys-phone');
  const ciRow = page.getByRole('listitem').filter({ hasText: 'CI deploy' });
  await ciRow.getByRole('button', { name: 'Access' }).click();
  const accessDialog = page.getByRole('alertdialog');
  await accessDialog.waitFor();
  await accessDialog
    .getByRole('listitem')
    .filter({ hasText: 'acme/app/staging' })
    .getByLabel('read')
    .check();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, '11e-access.png') });
  await page.getByRole('button', { name: 'Save access' }).click();
  await accessDialog.waitFor({ state: 'hidden' });
  await ciRow.getByText('acme/app/staging', { exact: true }).waitFor();
  check(
    'the owner gives a service account another environment, and it loads it with the key it had',
    varlockLoads(ciEnv, 'acme/app/staging', { API_KEY: 'staging-value' }).isLoaded,
  );
  await ciRow.getByRole('button', { name: 'Expiry' }).click();
  await page.getByLabel('Expires').selectOption('30');
  await page.getByRole('button', { name: 'Save expiry' }).click();
  await page.getByRole('alertdialog').waitFor({ state: 'hidden' });
  await ciRow.getByText(/expires in 30 days/).waitFor();
  check('the owner changes when a service account ends', true);
  await shoot(page, '11g-keys-after-access');

  // A key whose end has passed falls out of sight, and one click brings it back.
  const [migration] = d1(`SELECT expires_at FROM credential WHERE name = 'Migration agent'`);
  const onEndedKey = changeKey(['--read', 'acme/app/staging', '--reason', 'one more environment']);
  d1(`UPDATE credential SET expires_at = ${Date.now() - MINUTE_MS} WHERE name = 'Migration agent'`);
  await page.goto(`${WEB}/keys`);
  await page.getByText('CI deploy').waitFor();
  const keysWaiting = () =>
    page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Keys/ })
      .getByText(/waiting for you/)
      .count();
  check(
    'a change to a key that has ended waits on nobody: not counted, not listed',
    onEndedKey.json?.status === 'pending' &&
      (await keysWaiting()) === 0 &&
      (await page.getByText(/asks to change/).count()) === 0,
  );
  await page.goto(onEndedKey.json.url);
  await page.getByRole('heading', { name: 'Approve this change?' }).waitFor();
  check(
    'its page says the key has ended and offers only Reject',
    (await page.getByText(/has ended, so this change cannot be approved/).count()) === 1 &&
      (await page.getByRole('button', { name: 'Approve', exact: true }).count()) === 0,
  );
  await shoot(page, '11h0-key-change-ended');
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  await page.goto(`${WEB}/keys`);
  await page.getByText('CI deploy').waitFor();
  check(
    'a key that has ended is hidden, and counted in the button that shows it',
    (await page.getByText('Migration agent').count()) === 0 &&
      (await page.getByRole('button', { name: 'Show 1 ended key' }).count()) === 1,
  );
  await page.getByRole('button', { name: 'Show 1 ended key' }).click();
  await page.getByText('Migration agent').waitFor();
  check('the ended key is listed as expired', (await page.getByText('expired').count()) === 1);
  await shoot(page, '11h-keys-ended-shown');
  d1(
    `UPDATE credential SET expires_at = ${String(migration?.expires_at)} WHERE name = 'Migration agent'`,
  );

  // --- the environment, the bin and the activity --------------------------------------------------
  laptop.cli(['secret', 'set', 'acme/app/production', 'OLD_TOKEN'], {
    stdin: 'old-value',
    keyFile: agentKey,
  });
  const binned = laptop.cli(['secret', 'delete', 'acme/app/production', 'OLD_TOKEN'], {
    keyFile: agentKey,
  });
  check(
    'a deleted secret goes to the bin, and the CLI login lists it there by name',
    typeof binned.json?.purgeAt === 'number' &&
      laptop.cli(['bin', 'list']).json?.secrets?.[0]?.name === 'OLD_TOKEN',
  );
  await page.goto(`${WEB}/environments`);
  await page.getByRole('link', { name: /app\/production/ }).click();
  await page.getByText('STRIPE_SECRET_KEY').waitFor();
  const shownNames = await page.locator('main li code.text-base').allInnerTexts();
  check(
    'the environment lists its secrets by name, sorted in the browser, and no deleted one',
    JSON.stringify(shownNames) ===
      JSON.stringify(shownNames.toSorted((a, b) => a.localeCompare(b))) &&
      !shownNames.includes('OLD_TOKEN') &&
      shownNames.includes('API_KEY'),
  );
  await shoot(page, '10-environment');
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

  await page.getByLabel('New environment').fill('app/old');
  await page.getByRole('button', { name: 'Create environment' }).click();
  await page.getByRole('link', { name: /app\/old/ }).click();
  // A change waits for it, and the dashboard learns of it from what the owner does next.
  const toPurged = changeKey(['--read', 'acme/app/old', '--reason', 'one last look']);
  await page.getByRole('button', { name: 'Delete environment' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete environment' }).click();
  await page.waitForURL(`${WEB}/environments`);
  const keysWaitingNow = () =>
    page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: /^Keys/ })
      .getByText(/waiting for you/)
      .count();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Keys/ })
    .getByText('1 waiting for you')
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
  const environmentRow = page.getByRole('listitem').filter({ hasText: 'acme/app/old' });
  await environmentRow.getByRole('button', { name: 'Delete for good' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete for good' }).click();
  await page.getByText('The bin is empty').waitFor();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /^Keys/ })
    .getByText(/waiting for you/)
    .waitFor({ state: 'detached', timeout: 5000 })
    .catch(() => undefined);
  check(
    'a change naming an environment removed for good waits on nobody once it is gone',
    (await keysWaitingNow()) === 0,
  );
  await page.goto(toPurged.json.url);
  await page.getByRole('heading', { name: 'Approve this change?' }).waitFor();
  check(
    'its page says so and offers only Reject',
    (await page.getByText(/removed for good, so it cannot be approved/).count()) === 1 &&
      (await page.getByRole('button', { name: 'Approve', exact: true }).count()) === 0,
  );
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  check(
    'and the terminal hears it was not approved',
    laptop.cli(['ask', 'wait', toPurged.json.id]).status === 4,
  );
  await page.goto(`${WEB}/environments`);
  await page.getByLabel('New environment').fill('app/old');
  await page.getByRole('button', { name: 'Create environment' }).click();
  await page.getByRole('link', { name: /app\/old/ }).waitFor();
  check('an environment deleted for good frees its name', true);

  await page.goto(`${WEB}/activity`);
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
  await page.goto(`${WEB}/account`);
  await page.getByRole('heading', { name: 'Passkeys' }).waitFor();
  await shoot(page, '13-account');

  // --- an org stored the 0.7 way: the dashboard seals it, CI keeps loading ----------------------
  await page.getByLabel('Org name').fill('Legacy Ltd');
  await page.getByLabel('Slug').fill('legacy');
  await page.getByRole('button', { name: 'Create org' }).click();
  await page.getByRole('main').getByText('Legacy Ltd').waitFor();
  await shoot(page, '13e-account-orgs');
  await page.goto(`${WEB}/environments`);
  await page.getByText('No environments in Legacy Ltd yet').waitFor();
  await page.getByLabel('New environment').fill('app/legacy');
  await page.getByRole('button', { name: 'Create environment' }).click();
  await page.getByRole('link', { name: /legacy\/app\/legacy/ }).click();
  await page.getByRole('button', { name: 'Add a secret' }).click();
  await page.getByLabel('Name').fill('LEGACY_TOKEN');
  await page.getByLabel('Value').fill('legacy-value');
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.getByText(/sealed · \d+ B · v1/).waitFor();
  const legacyCiKey = join(laptop.home, 'legacy-ci-key');
  const legacyAsk = laptop.cli([
    'ask',
    'access',
    '--read',
    'legacy/app/legacy',
    '--reason',
    'CI: legacy deploy',
    '--name',
    'Legacy CI',
    '--',
    'sh',
    '-c',
    `cat > ${legacyCiKey}`,
  ]);
  await page.goto(legacyAsk.json.url);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  laptop.cli(['ask', 'wait', legacyAsk.json.id]);
  const legacyEnv = { ...ci.env, BAYMUTT_KEY: readFileSync(legacyCiKey, 'utf8').trim() };
  const legacyOrg = laptop
    .cli(['org', 'list'])
    .json?.orgs?.find((org: { slug: string }) => org.slug === 'legacy');
  const legacyEnvironment = laptop
    .cli(['env', 'list'])
    .json?.environments?.find((environment: { name: string }) => environment.name === 'app/legacy');
  if (legacyOrg === undefined || legacyEnvironment === undefined) fail('the legacy org is listed');
  // Leave the dashboard before the store changes under it, so nothing seals until it is opened. A
  // browser that saw the org sealed would refuse it unsealed: this one forgets it ever did, as a
  // browser from before 0.8 never knew.
  await page.goto(`${WEB}/signin`);
  await page.evaluate(orgId => {
    for (const key of Object.keys(localStorage).filter(key =>
      key.startsWith('baymutt.sealedOrgs.'),
    )) {
      const seen: unknown = JSON.parse(localStorage.getItem(key) ?? '[]');
      if (Array.isArray(seen)) {
        localStorage.setItem(key, JSON.stringify(seen.filter(id => id !== orgId)));
      }
    }
  }, legacyOrg.id);
  await page.goto('about:blank');
  const [org, environment] = [sqlText(legacyOrg.id), sqlText(legacyEnvironment.id)];
  d1(`
    PRAGMA defer_foreign_keys = on;
    DELETE FROM names_key_wrap WHERE org_id = ${org};
    UPDATE environment SET name = 'app/legacy', sealed_name = NULL WHERE id = ${environment};
    UPDATE secret_version SET name = 'LEGACY_TOKEN' WHERE environment_id = ${environment};
    UPDATE secret SET name = 'LEGACY_TOKEN', sealed_name = NULL WHERE environment_id = ${environment};
    UPDATE activity_event SET environment_name = 'app/legacy', environment_sealed_name = NULL
      WHERE environment_id = ${environment};
    UPDATE activity_event SET secret_name = 'LEGACY_TOKEN', secret_sealed_name = NULL
      WHERE environment_id = ${environment} AND secret_name IS NOT NULL;
  `);
  const isSealed = () =>
    d1(`SELECT count(*) AS wraps FROM names_key_wrap WHERE org_id = ${org}`)[0]?.wraps !== 0;
  check(
    'an org stored the 0.7 way has its names as written and no names key',
    !isSealed() &&
      laptop
        .cli(['org', 'list'])
        .json?.orgs?.find((listed: { slug: string }) => listed.slug === 'legacy')
        ?.areNamesSealed === false,
  );
  check(
    'its service account loads it before the dashboard is opened',
    varlockLoads(legacyEnv, 'legacy/app/legacy', { LEGACY_TOKEN: 'legacy-value' }).isLoaded,
  );
  // Its only environment there is in the bin while the org is sealed.
  d1(`UPDATE environment SET deleted_at = ${Date.now()}, purge_at = ${Date.now() + 30 * 24 * 60 * MINUTE_MS}
      WHERE id = ${environment}`);
  // The picker still shows the org made last.
  await page.goto(`${WEB}/environments`);
  await page.getByText('No environments in Legacy Ltd yet').waitFor();
  let sealed = false;
  for (let attempt = 0; attempt < 40 && !sealed; attempt++) {
    sealed = isSealed();
    if (!sealed) await page.waitForTimeout(250);
  }
  check('opening the dashboard seals the org’s names', sealed);
  check(
    'a service account whose environment there is in the bin gets the org’s names too',
    d1(`SELECT count(*) AS wraps FROM names_key_wrap
        WHERE org_id = ${org} AND reader_id = ${sqlText(legacyAsk.json.id)}`)[0]?.wraps === 1,
  );
  d1(`UPDATE environment SET deleted_at = NULL, purge_at = NULL WHERE id = ${environment}`);
  check(
    'the store no longer keeps the names as written',
    d1(`SELECT name FROM environment WHERE id = ${environment}`)[0]?.name !== 'app/legacy' &&
      d1(`SELECT name FROM secret WHERE environment_id = ${environment}`)[0]?.name !==
        'LEGACY_TOKEN',
  );
  check(
    'its service account still loads it after sealing',
    varlockLoads(legacyEnv, 'legacy/app/legacy', { LEGACY_TOKEN: 'legacy-value' }).isLoaded,
  );
  check(
    'the CLI login lists the sealed names',
    laptop
      .cli(['secret', 'list', 'legacy/app/legacy'])
      .json?.secrets?.some((secret: { name: string }) => secret.name === 'LEGACY_TOKEN') === true,
  );
  await page.reload();
  await page.getByRole('link', { name: /legacy\/app\/legacy/ }).click();
  await page.getByText('LEGACY_TOKEN').waitFor();
  await shoot(page, '13f-legacy-environment-sealed');
  check('the dashboard shows the sealed names', true);

  // --- a store that hides the names key of an org this browser has seen sealed -----------------
  const keptWraps = d1(
    `SELECT reader_id, wrap, created_at FROM names_key_wrap WHERE org_id = ${org}`,
  );
  const [keptName] = d1(`SELECT name, sealed_name FROM environment WHERE id = ${environment}`);
  await page.goto('about:blank');
  d1(`DELETE FROM names_key_wrap WHERE org_id = ${org};
      UPDATE environment SET name = 'app/made-up', sealed_name = NULL WHERE id = ${environment};`);
  await page.goto(`${WEB}/environments`);
  await page.getByRole('link', { name: /legacy\/name does not open/ }).waitFor();
  await page.getByLabel('New environment').fill('app/other');
  await page.getByRole('button', { name: 'Create environment' }).click();
  await page.getByText(/did not hand over this org’s names/).waitFor();
  await shoot(page, '13g-names-withheld');
  check(
    'an org seen sealed shows no name the store made up, makes nothing, and is not sealed again',
    !(await page.content()).includes('app/made-up') && !isSealed(),
  );
  await page.goto('about:blank');
  d1(`UPDATE environment SET name = ${sqlText(String(keptName?.name))},
        sealed_name = ${sqlText(String(keptName?.sealed_name))} WHERE id = ${environment};
      ${keptWraps
        .map(
          ({ reader_id, wrap, created_at }) =>
            `INSERT INTO names_key_wrap (org_id, reader_id, wrap, created_at) VALUES (${org}, ${sqlText(String(reader_id))}, ${sqlText(String(wrap))}, ${Number(created_at)});`,
        )
        .join('\n')}`);
  await page.goto(`${WEB}/environments`);
  await page.getByLabel('Org', { exact: true }).selectOption({ label: 'Acme' });
  await page.getByRole('link', { name: /acme\/app\/production/ }).waitFor();

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
  await page.goto(`${WEB}/keys`);
  await page.getByText('No CLI logins yet').waitFor();
  await shoot(page, '14b-keys-empty');
  await page.goto(`${WEB}/paste-links`);
  await page.getByText('Nothing is waiting on you').waitFor();
  await shoot(page, '14c-paste-links-empty');

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
  await page.goto(`${WEB}/keys`);
  await page.getByText('No CLI logins yet').waitFor();
  await shoot(page, '16b-keys-empty-dark');
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

  for (const directory of [laptop.home, ci.home])
    rmSync(directory, { recursive: true, force: true });
  console.log(`\nAll checks passed. Screens: ${shots}`);
};

const browser = await chromium.launch({ args: ['--mute-audio'] });
try {
  await main(browser);
} finally {
  await browser.close();
}
