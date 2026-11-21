// The decision pages beyond the ask drive (`asks.ts`): pairing a CLI login, a service account for
// CI piped into a command, an ask naming an environment whose name does not open, and the ask page
// in the dark scheme.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  check,
  cliBin,
  computer,
  DESKTOP,
  d1,
  fail,
  type Run,
  sendAsk,
  shooter,
  shownIn,
  sqlText,
  varlockLoads,
  waitAsk,
} from '../support.ts';

const { shoot, shootPhone } = shooter('approvals');

/** `baymutt auth login`: the pairing page, and what a CLI login lists. */
export const pairing = async ({ browser, page }: Pick<Run, 'browser' | 'page'>) => {
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
  await signedOutPage.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
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
      /^As the terminal asked: /.test(await shownIn(page, 'Ends')),
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
    'the CLI login lists the environment by its name, and reads nothing',
    production !== undefined && !production.canRead,
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
    'the CLI has no command that writes a value: it asks for one in an ask',
    laptop.cli(['secret', 'set', 'acme/app/production', 'API_KEY'], { stdin: 'nope' }).status !== 0,
  );
  return { laptop, production };
};

/** A service account for CI: an ask's `access` step with a command, piped into it once approved. */
export const ciKey = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const ciKeyFile = join(laptop.home, 'ci-key');
  const ask = sendAsk(laptop, {
    reason: 'CI: deploy',
    steps: [
      {
        type: 'access',
        name: 'CI deploy',
        read: ['acme/app/production'],
        command: ['sh', '-c', `cat > ${ciKeyFile}`],
      },
    ],
  });
  await page.goto(ask.url);
  await page.getByRole('button', { name: 'Approve key' }).waitFor();
  check(
    'a key piped into a command is a service account that only reads, with no end as asked',
    (await page.getByText(/^The new service account key can only read\./).count()) === 1 &&
      (await shownIn(page, 'Ends')) === 'Never, as asked',
  );
  await shoot(page, '08h-ask-piped');
  await page.getByRole('button', { name: 'Approve key' }).click();
  await page.getByRole('heading', { name: 'Ask answered' }).waitFor();
  const delivered = waitAsk(laptop, ask.id);
  check(
    'the key is piped into the command once approved, and kept nowhere else',
    delivered.status === 0 && delivered.steps[0]?.keyFile === undefined,
  );
  const ci = computer('ci');
  const ciEnv = { ...ci.env, BAYMUTT_KEY: readFileSync(ciKeyFile, 'utf8').trim() };
  check(
    'the CI key loads its environment under varlock run',
    varlockLoads(ciEnv, 'acme/app/production', {
      SIGNING_KEY: '-----BEGIN KEY-----\nmade-up-line-two\n-----END KEY-----',
    }).isLoaded,
  );
  check(
    'the CI key reaches nothing it was not given',
    spawnSync('node', [cliBin, 'secret', 'list', 'acme/worker/staging'], {
      env: ciEnv,
      encoding: 'utf8',
    }).status === 5,
  );
  return { ci, ciEnv };
};

/** An ask naming an environment whose name does not open: it can only be rejected until it does. */
export const unopenedNames = async ({
  laptop,
  page,
  production,
}: Pick<Run, 'laptop' | 'page' | 'production'>) => {
  const ask = sendAsk(laptop, {
    reason: 'read production',
    steps: [{ type: 'access', name: 'Production reader', read: ['acme/app/production'] }],
  });
  // The store files production's sealed name as another environment's: it opens, but not to its
  // own index.
  const [productionRow] = d1(
    `SELECT id, sealed_name FROM environment WHERE id = ${sqlText(String(production?.id))}`,
  );
  if (productionRow === undefined) fail('production is in the store');
  await page.goto('about:blank');
  d1(`UPDATE environment SET sealed_name = (SELECT sealed_name FROM environment
        WHERE org_id = (SELECT org_id FROM environment WHERE id = ${sqlText(String(productionRow?.id))})
          AND id <> ${sqlText(String(productionRow?.id))} LIMIT 1)
      WHERE id = ${sqlText(String(productionRow?.id))}`);
  await page.goto(ask.url);
  await page.getByText('acme/name does not open').first().waitFor();
  check(
    'an ask naming an environment whose name does not open says so, and can only be rejected',
    (await page
      .getByText(/could not be opened by your vault\. This step can only be rejected\./)
      .count()) === 1 && (await page.getByRole('button', { name: 'Approve key' }).count()) === 0,
  );
  await shoot(page, '08i-ask-name-unopened');
  await page.goto('about:blank');
  d1(`UPDATE environment SET sealed_name = ${sqlText(String(productionRow?.sealed_name))}
        WHERE id = ${sqlText(String(productionRow?.id))}`);
  await page.goto(ask.url);
  await page.getByText('acme/app/production', { exact: true }).first().waitFor();
  check(
    'once the name opens again, the step can be approved',
    await page.getByRole('button', { name: 'Approve key' }).isEnabled(),
  );
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByRole('heading', { name: 'Ask answered' }).waitFor();
};

/**
 * The ask page in the dark scheme, desktop and phone: a new key, a value to paste, and the ask
 * answered. Each step is answered, so nothing is left waiting for later steps.
 */
export const decisionsDark = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const ask = sendAsk(laptop, {
    reason: 'set up the Stripe webhook and save its signing secret',
    steps: [
      {
        type: 'access',
        name: 'Stripe webhooks',
        read: ['acme/app/production'],
        expires: '1h',
      },
      {
        type: 'secrets',
        items: [
          {
            op: 'paste',
            environment: 'acme/app/production',
            name: 'STRIPE_WEBHOOK_SECRET',
            hint: 'Stripe dashboard, Webhooks',
          },
        ],
      },
    ],
  });
  await page.goto(ask.url);
  await page.getByRole('button', { name: 'Approve key' }).waitFor();
  await page.mouse.move(0, 0);
  await shoot(page, '19-ask-access-dark');
  await shootPhone(page, '19b-ask-access-dark-phone');
  await page.getByRole('button', { name: 'Approve key' }).click();
  await page.getByLabel('STRIPE_WEBHOOK_SECRET').waitFor();
  await page.mouse.move(0, 0);
  await shoot(page, '19g-ask-paste-dark');
  await shootPhone(page, '19h-ask-paste-dark-phone');
  await page.getByLabel('STRIPE_WEBHOOK_SECRET').fill('whsec_made_up_for_the_drive');
  await page.getByRole('button', { name: 'Approve secret change' }).click();
  await page.getByRole('heading', { name: 'Ask answered' }).waitFor();
  await shoot(page, '19c-ask-answered-dark');
  await shootPhone(page, '19d-ask-answered-dark-phone');
  await page.emulateMedia({ colorScheme: 'light' });
  check(
    'the ask page and its outcome draw in the dark scheme, and both steps go through',
    waitAsk(laptop, ask.id).status === 0,
  );
  await page.setViewportSize(DESKTOP);
};
