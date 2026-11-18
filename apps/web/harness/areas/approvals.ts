// The approvals area's steps: pairing, ask access, ask change, ask create-environment, paste.
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
  MINUTE_MS,
  PHONE,
  pick,
  type Run,
  shooter,
  shownIn,
  sqlText,
  varlockLoads,
  WEB,
} from '../support.ts';
import * as environments from './environments.ts';
import * as lists from './lists.ts';

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
  return { laptop, production };
};

/** `baymutt ask access`: the request page, approved with a shorter end; the key file loads. */
export const askAccess = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
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
      asked.json?.url.includes('/orgs/acme/ask/access/'),
  );
  await lists.keysRequestWaiting(page);
  await page.getByRole('link', { name: 'Review' }).click();
  await page.getByRole('heading', { name: '“run the migration”' }).waitFor();
  check('the Review link opens the request’s own page', page.url() === asked.json.url);
  check(
    'the request page shows the login, the reason, the environment and what was asked for',
    (await page.getByText('Work laptop').count()) > 0 &&
      (await page.getByText('“run the migration”').count()) === 1 &&
      (await page.getByText('acme/app/production').count()) === 1 &&
      (await page.getByText('read and write', { exact: true }).count()) === 1 &&
      (await shownIn(page, 'Ends')) === '1 hour after approval, as asked',
  );
  await pick(page, 'Ends', /^15 minutes after approval/);
  check(
    'the request page says approving a key kept in a file makes an agent key',
    (await page
      .getByText('Approving makes an agent key, kept in a file on Work laptop.')
      .count()) === 1,
  );
  check(
    'the request page says who asked, and when the owner approved that CLI login',
    /^Asked just now by Work laptop, a CLI login you approved (just now|\d+ minutes? ago)\.$/.test(
      await page.locator('.vouch').innerText(),
    ),
  );
  await shoot(page, '08b-request');
  await shootPhone(page, '08c-request-phone');
  await page.getByRole('button', { name: 'Approve read and write' }).click();
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
  return { asked, agentKey, agentEnv };
};

/** `baymutt ask create-environment`: created, then rejected. */
export const environmentRequest = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
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
      creating.json?.url === `${WEB}/orgs/acme/ask/create-environment/${creating.json?.id}`,
  );
  await environments.environmentsRequestWaiting(page);
  await page.getByRole('link', { name: 'Review' }).click();
  await page.getByRole('heading', { name: '“set up staging”' }).waitFor();
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
  await page.getByRole('button', { name: 'Approve read and write' }).click();
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
  await page.goto(`${WEB}/orgs/acme/environments`);
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
  await page.goto(`${WEB}/orgs/acme/ask/create-environment/${crypto.randomUUID()}`);
  await page.getByRole('heading', { name: 'No request at this link' }).waitFor();
  check('a missing environment request says so', true);
  return { creating };
};

/** A request at the longest name and reason, rejected; and one at a missing link. */
export const rejectedRequest = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const longName = 'Warehouse reconciliation agent for the nightly billing job';
  const longReason =
    'reconcile the nightly billing export against the warehouse, then write the corrected totals back to production before the reports run at six';
  const rejected = laptop.cli([
    'ask',
    'access',
    '--read',
    'acme/app/production',
    '--reason',
    longReason,
    '--name',
    longName,
  ]);
  if (rejected.json === undefined) fail(`the long request: ${rejected.stderr}`);
  await page.setViewportSize(PHONE);
  await page.goto(rejected.json.url);
  await page.getByRole('heading', { name: `“${longReason}”` }).waitFor();
  check(
    `on a 390×844 phone a request with a ${longName.length}-character name and a ${longReason.length}-character reason fits one screen, both buttons and the vouch line`,
    await page.locator('.vouch').evaluate(vouch => vouch.getBoundingClientRect().bottom <= 844),
  );
  await shoot(page, '08f0-request-long-phone');
  await page.setViewportSize(DESKTOP);
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  await shoot(page, '08f-request-rejected');
  const rejectedWait = laptop.cli(['ask', 'wait', rejected.json.id]);
  check('a rejected request ends the terminal’s wait with no key', rejectedWait.status === 4);
  await page.goto(`${WEB}/orgs/acme/ask/access/${crypto.randomUUID()}`);
  await page.getByRole('heading', { name: 'No request at this link' }).waitFor();
  await shoot(page, '08g-request-missing');
  check('a missing request says so', true);
};

/** `baymutt ask change`: gains, gives back, a new end. */
export const keyChange = async ({
  agentKey,
  asked,
  laptop,
  page,
}: Pick<Run, 'agentKey' | 'asked' | 'laptop' | 'page'>) => {
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
      moving.json?.url === `${WEB}/orgs/acme/ask/change/${moving.json?.id}`,
  );
  await page.goto(`${WEB}/orgs/acme/keys`);
  await page.getByRole('heading', { name: 'Waiting for you' }).waitFor();
  check(
    'a key change waits under Keys, counted in the nav',
    (await page.getByText(/asks to change/).count()) === 1 &&
      (await page.getByRole('navigation', { name: 'Acme' }).getByText('1 waiting').count()) === 1,
  );
  await page.getByRole('link', { name: 'Review' }).click();
  await page.getByRole('heading', { name: '“the migration moves on to staging”' }).waitFor();
  check('the Review link opens the change’s own page', page.url() === moving.json.url);
  check(
    'the change page shows what the key holds now, what it adds, what it gives back, and the end asked for',
    (await page.getByText('“the migration moves on to staging”').count()) === 1 &&
      (await page.getByRole('heading', { name: 'It holds now' }).count()) === 1 &&
      (await page.getByRole('heading', { name: 'It adds' }).count()) === 1 &&
      (await page.getByRole('heading', { name: 'It gives back' }).count()) === 1 &&
      (await page.getByText('acme/app/staging').count()) === 1 &&
      (await page.getByText('acme/app/production').count()) === 2 &&
      (await shownIn(page, 'Ends')) === '1 day after approval, as asked',
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
  await page.getByRole('button', { name: 'Approve the change' }).waitFor();
  check(
    'a change that asks for no new end keeps the key’s own by default',
    /^As it is: /.test(await shownIn(page, 'Ends')),
  );
  await shoot(page, '08h3-key-change');
  await shootPhone(page, '08h4-key-change-phone');
  await page.getByRole('button', { name: 'Approve the change' }).click();
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
  await page.getByRole('button', { name: 'Approve the change' }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  check(
    'a change that only adds, once approved, loads both',
    laptop.cli(['ask', 'wait', adding.json.id]).status === 0 &&
      loadsWithAgentKey('acme/app/staging') &&
      loadsWithAgentKey('acme/app/production'),
  );
  await lists.keysAfterChange(page);

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
  await page.getByRole('button', { name: 'Approve the change' }).waitFor();
  check(
    'a new end alone waits for the owner, and offers what was asked',
    extending.json?.status === 'pending' &&
      (await shownIn(page, 'Ends')) === '2 hours after approval, as asked' &&
      (await page.getByText('It gains nothing. Rejecting leaves it as it is.').count()) === 1,
  );
  await page.getByRole('button', { name: 'Approve the change' }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  const extended = laptop.cli(['ask', 'wait', extending.json.id]);
  check(
    'the new end counts from the approval',
    extended.status === 0 &&
      Math.abs(extended.json.expiresAt - (Date.now() + 120 * MINUTE_MS)) < 2 * MINUTE_MS,
  );
  await page.goto(`${WEB}/orgs/acme/ask/change/${crypto.randomUUID()}`);
  await page.getByRole('heading', { name: 'No change at this link' }).waitFor();
  check('a missing key change says so', true);
  return { changeKey };
};

/** A name that does not open: nothing is approved or pasted for it. */
export const unopenedNames = async ({
  creating,
  laptop,
  page,
  production,
}: Pick<Run, 'creating' | 'laptop' | 'page' | 'production'>) => {
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
      (await page.getByRole('button', { name: 'Approve read' }).isDisabled()),
  );
  await shoot(page, '08i-request-name-unopened');
  await page.goto(unopenedPaste.json.url);
  await page.getByText(/nothing can be saved for it/).waitFor();
  check(
    'a paste link whose environment’s name does not open says so, and takes no value',
    (await page.getByText('acme/name does not open').count()) === 1 &&
      (await page.getByLabel('Value').isDisabled()) &&
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
    !(await page.getByRole('button', { name: 'Approve read' }).isDisabled()),
  );
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
};

/** A paste link, answered by the signed-in owner alone. */
export const pasteLink = async ({
  agentEnv,
  browser,
  laptop,
  page,
}: Pick<Run, 'agentEnv' | 'browser' | 'laptop' | 'page'>) => {
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
  await strangerPage.getByRole('heading', { name: 'Sign in', exact: true }).waitFor();
  check(
    'a paste link opened signed out asks to sign in where it is',
    strangerPage.url() === pasteLink.json.url &&
      (await strangerPage.getByLabel('Value').count()) === 0,
  );
  await shoot(strangerPage, '09-paste-signed-out-phone');
  await stranger.close();
  await lists.pasteLinks(page);
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
  await page.getByRole('heading', { name: 'Paste STRIPE_SECRET_KEY' }).waitFor();
  check(
    'the paste page’s bar names the org, and Paste links with what waits there',
    (await page.locator('.dbar-org').innerText()) === 'Acme' &&
      /^Paste links \d+ waiting$/.test(await page.locator('.dbar-back').innerText()),
  );
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
  await page.getByRole('heading', { name: 'Paste STRIPE_SECRET_KEY' }).waitFor();
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
  check(
    'a paste link works once, and a spent one names no org and no way back',
    (await page.locator('.dbar-org').innerText()) === 'baymutt' &&
      (await page.locator('.dbar-back').count()) === 0,
  );
  check(
    'the pasted value is the environment’s, under its name',
    varlockLoads(agentEnv, 'acme/app/production', {
      STRIPE_SECRET_KEY: 'sk_made_up_for_this_run',
    }).isLoaded,
  );
};

/** A service account for CI, piped into a command once approved. */
export const ciKey = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
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
    (await shownIn(page, 'Ends')) === 'Never, as asked' &&
      (await page.getByText(/With no end, it works until you revoke it/).count()) === 1,
  );
  check(
    'the request page says approving a key piped into a command makes a service account',
    (await page.getByText(/^Approving makes a service account\. Its key goes into/).count()) === 1,
  );
  await shoot(page, '08h-request-piped');
  await page.getByRole('button', { name: 'Approve read' }).click();
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
  await page.getByRole('button', { name: 'Approve the change' }).waitFor();
  check(
    '`baymutt ask change` asks for a service account too, and its page names it as one',
    ciChange.json?.status === 'pending' &&
      (await page.getByText(/asks to change the service account/).count()) === 1,
  );
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();
  return { ci, ciEnv };
};

/**
 * The decision pages in the dark scheme, desktop and phone: ask access, its Approved outcome, a
 * key change, and a paste link. Each is answered, so nothing is left waiting for later steps.
 */
export const decisionsDark = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const asked = laptop.cli([
    'ask',
    'access',
    '--read',
    'acme/app/production',
    '--write',
    'acme/app/production',
    '--reason',
    'set up the Stripe webhook and save its signing secret',
    '--expires',
    '1h',
    '--name',
    'Stripe webhooks',
  ]);
  await page.goto(asked.json.url);
  await page.getByRole('button', { name: 'Approve read and write' }).waitFor();
  await shoot(page, '19-ask-access-dark');
  await shootPhone(page, '19b-ask-access-dark-phone');
  await page.getByRole('button', { name: 'Approve read and write' }).click();
  await page.getByRole('heading', { name: 'Approved', exact: true }).waitFor();
  await shoot(page, '19c-approved-dark');
  await shootPhone(page, '19d-approved-dark-phone');
  laptop.cli(['ask', 'wait', asked.json.id]);

  const change = laptop.cli([
    'ask',
    'change',
    asked.json.id,
    '--read',
    'acme/app/staging',
    '--reason',
    'check the webhook on staging too',
  ]);
  await page.goto(change.json.url);
  await page.getByRole('button', { name: 'Approve the change' }).waitFor();
  await shoot(page, '19e-key-change-dark');
  await shootPhone(page, '19f-key-change-dark-phone');
  await page.getByRole('button', { name: 'Reject' }).click();
  await page.getByRole('heading', { name: 'Rejected', exact: true }).waitFor();

  const paste = laptop.cli([
    'ask',
    'paste-link',
    'acme/app/production',
    'STRIPE_WEBHOOK_SECRET',
    '--reason',
    'to verify webhook events',
    '--where',
    'Stripe dashboard, Webhooks',
  ]);
  await page.goto(paste.json.url);
  await page.getByLabel('Value').waitFor();
  await shoot(page, '19g-paste-dark');
  await shootPhone(page, '19h-paste-dark-phone');
  await page.getByLabel('Value').fill('whsec_made_up_for_the_drive');
  await page.getByRole('button', { name: 'Seal and save' }).click();
  await page.getByRole('heading', { name: 'Saved', exact: true }).waitFor();
  await page.emulateMedia({ colorScheme: 'light' });
  check(
    'the decision pages and an outcome draw in the dark scheme',
    asked.status === 0 && change.status === 0 && paste.status === 0,
  );
};
