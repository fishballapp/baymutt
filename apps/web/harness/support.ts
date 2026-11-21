/**
 * What every step of the drive shares: the dev server's address, the helpers that sign in, run
 * the CLI and varlock, read the local D1, pick from a select and save screens, and `Run`, the state
 * one step leaves for later ones. The drive's own doc is in `drive.ts`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/** The dashboard's dev server: `BAYMUTT_WEB_PORT`, 5183 by default, as `pnpm -F @baymutt/web dev` uses. */
export const WEB = `http://localhost:${process.env.BAYMUTT_WEB_PORT ?? 5183}`;
export const shots = fileURLToPath(new URL('../tmp/drive', import.meta.url));
export const cliBin = fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
export const pluginFile = fileURLToPath(
  new URL('../../../packages/varlock-plugin/dist/plugin.cjs', import.meta.url),
);
export const workerDir = fileURLToPath(new URL('../../worker-web/', import.meta.url));
export const varlockBin = join(workerDir, 'node_modules/.bin/varlock');
export const wranglerBin = join(workerDir, 'node_modules/.bin/wrangler');

export const PHONE = { width: 390, height: 844 };

/** A made-up value long enough to wrap: one line of JSON. */
export const LONG_VALUE = JSON.stringify({
  type: 'service_account',
  project_id: 'made-up-project',
  private_key_id: 'f'.repeat(40),
  client_email: 'deploy@made-up-project.example.test',
  token_uri: 'https://example.test/token',
  universe_domain: 'example.test',
});
export const DESKTOP = { width: 1280, height: 860 };

export const fail = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

export const check = (label: string, isTrue: boolean) => {
  if (!isTrue) fail(label);
  console.log(`✓ ${label}`);
};

/** A computer with a CLI login: its own key file and state, so nothing touches this Mac's keychain. */
export const computer = (name: string) => {
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
export const withPasskeys = async (browser: Browser, colorScheme: 'light' | 'dark' = 'light') => {
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

/** Whose screens a run saves: `DRIVE_SHOTS=lists,account` saves those areas' alone; unset saves all. */
const shotAreas = process.env.DRIVE_SHOTS?.split(',').map(area => area.trim());

export type Area = 'shell' | 'account' | 'approvals' | 'environments' | 'lists' | 'asks';

/**
 * The shooting functions of one area. `shoot` saves the full page; `shootPhone` the same screen at
 * a phone's width, then back. Both do nothing when `DRIVE_SHOTS` leaves the area out, while every
 * wait and check still runs.
 */
export const shooter = (area: Area) => {
  const isShot = shotAreas === undefined || shotAreas.includes(area);
  const shoot = async (page: Page, name: string) => {
    if (!isShot) return;
    await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  };
  const shootPhone = async (page: Page, name: string) => {
    if (!isShot) return;
    await page.setViewportSize(PHONE);
    await shoot(page, name);
    await page.setViewportSize(DESKTOP);
  };
  return { shoot, shootPhone };
};

/** Whether this browser still holds the key that keeps the vault open. */
export const keepsVaultOpen = (page: Page) =>
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
export const followLink = async (page: Page, from: '/signup' | '/recover', email: string) => {
  await page.goto(`${WEB}${from}`);
  await page.getByLabel('Email').fill(email);
  await page.getByRole('button', { name: /^Email me a link/ }).click();
  await page.getByRole('heading', { name: 'Check your inbox' }).waitFor();
  const answer = await fetch(`${WEB}/api/dev/magic-link?email=${encodeURIComponent(email)}`);
  const { token } = (await answer.json()) as { token: string };
  const landOn = from === '/signup' ? '/orgs' : '/recover';
  await page.goto(`${WEB}/api/auth/magic-link/verify?token=${token}&callbackURL=${landOn}`);
};

export const keepRecoveryKey = async (page: Page): Promise<string> => {
  await page.getByRole('heading', { name: 'Keep your recovery key' }).waitFor();
  const recoveryKey = (await page.locator('.entry-key').innerText()).trim();
  await page.getByRole('checkbox').check();
  return recoveryKey;
};

/**
 * Whether `varlock run`, through the built plugin, loads `environment` with the key `env` names
 * and hands the child exactly `expected`.
 */
export const varlockLoads = (
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
export const d1 = (sql: string): ReadonlyArray<Record<string, unknown>> => {
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

export const sqlText = (text: string) => `'${text.replaceAll("'", "''")}'`;

export const MINUTE_MS = 60_000;

/** What the select labelled `label` shows now. */
export const shownIn = (page: Page, label: string) =>
  page.getByRole('combobox', { name: label, exact: true }).innerText();

/** Opens the select labelled `label` and picks the option that reads `option`. */
export const pick = async (page: Page, label: string, option: string | RegExp) => {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: option }).click();
};

export type Computer = ReturnType<typeof computer>;
export type CliResult = ReturnType<Computer['cli']>;

/** An ask `baymutt ask` sent: its id and the ask page's link. */
export type Asked = { readonly id: string; readonly url: string };

/**
 * Sends `ask` with `baymutt ask` from `computer`, its values in files under one directory that
 * `$DIR` in the ask names. Fails the drive when the CLI refuses it.
 */
export const sendAsk = (
  computer: Computer,
  ask: object,
  values: Readonly<Record<string, string>> = {},
): Asked => {
  const asked = sendAskRaw(computer, ask, values);
  if (asked.status !== 0 || typeof asked.json?.url !== 'string') {
    fail(`\`baymutt ask\` refused the ask: ${asked.stderr}`);
  }
  return asked.json as Asked;
};

/** `baymutt ask` with `ask`, as it answers: for an ask the CLI is to refuse. */
export const sendAskRaw = (
  computer: Computer,
  ask: object,
  values: Readonly<Record<string, string>> = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'baymutt-drive-ask-'));
  for (const [file, value] of Object.entries(values)) writeFileSync(join(dir, file), value);
  writeFileSync(join(dir, 'ask.json'), JSON.stringify(ask).replaceAll('$DIR', dir));
  const asked = computer.cli(['ask', '--no-wait', join(dir, 'ask.json')]);
  rmSync(dir, { recursive: true, force: true });
  return asked;
};

/**
 * `baymutt ask` left running, as an agent's background job is: `printedLink` settles with what it
 * has printed once it prints the ask's link, `done` with its exit code and every line it printed.
 */
export const startAsk = (computer: Computer, ask: object) => {
  const child = spawn('node', [cliBin, 'ask'], {
    env: computer.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end(JSON.stringify(ask));
  let stdout = '';
  let stderr = '';
  const link = Promise.withResolvers<string>();
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    stdout += chunk;
    // The first thing it prints is one pretty-printed object.
    if (stdout.includes('\n}\n')) link.resolve(stdout);
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  return {
    printedLink: link.promise,
    isRunning: () => child.exitCode === null,
    /** Everything printed so far. */
    output: () => stdout,
    done,
  };
};

export type WaitedStep = {
  readonly index: number;
  readonly status: string;
  readonly note?: string;
  readonly keyFile?: string;
  readonly piped?: boolean;
  readonly expiresAt?: number | null;
  readonly holds?: ReadonlyArray<{ readonly environment: string }>;
};

/** `baymutt ask wait <id>`: its exit code and one JSON line per step. */
export const waitAsk = (computer: Computer, id: string) => {
  const run = spawnSync('node', [cliBin, 'ask', 'wait', id, '--timeout', '0'], {
    env: computer.env,
    encoding: 'utf8',
  });
  const steps = run.stdout
    .split('\n')
    .filter(line => line.startsWith('{'))
    .map(line => JSON.parse(line) as WaitedStep);
  return { status: run.status, steps, stderr: run.stderr };
};

/** What one step leaves for later ones. The runner hands each step the part it names. */
export type Run = {
  readonly browser: Browser;
  /** The owner's browser: a virtual passkey, the vault open. */
  readonly context: BrowserContext;
  readonly page: Page;
  readonly recoveryKey: string;
  /** The CLI login "Work laptop", and the CI computer. */
  readonly laptop: Computer;
  readonly ci: Computer;
  readonly production: CliResult['json'];
  /** The agent key a one-step ask made ("Stripe webhook check"). */
  readonly keyId: string;
  /** An ask whose `change` step names an environment then removed for good. */
  readonly toPurged: Asked;
  readonly ciEnv: NodeJS.ProcessEnv;
};
