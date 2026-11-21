// The plans area's steps: what `baymutt ask` sends, answered on the plan page step by step, and
// each approval checked from the terminal (`ask wait`) and from what it made.
import type { Page } from '@playwright/test';
import {
  askPlan,
  check,
  d1,
  fail,
  MINUTE_MS,
  pick,
  type Run,
  shooter,
  sqlText,
  varlockLoads,
  WEB,
  waitPlan,
} from '../support.ts';

const shots = shooter('plans');
// The pointer leaves the page first, so no line of the outline is drawn hovered.
const shoot = async (page: Page, name: string) => {
  await page.mouse.move(0, 0);
  await shots.shoot(page, name);
};
const shootPhone = async (page: Page, name: string) => {
  await page.mouse.move(0, 0);
  await shots.shootPhone(page, name);
};

/** Made-up values the plans propose; none is real. */
export const ACCOUNT_ID = '8f3c1a9e27d64b05a1c3e9f7d2b8460e';
const SENTRY_DSN = 'https://made-up-key@example.test/4504';
const STRIPE_KEY = 'sk_test_made_up_51Nq8ZbHk2vXcR7tYw4mLp0aQ';
const RESEND_KEY = 're_made_up_8Kq2mZt5_Ux7VbN4wQyE1hRdLp9';
const NOTE = 'acme/app/production is prod; read acme/app/staging instead';

const outlineItem = (page: Page, index: number) => page.locator('.outline-item').nth(index);

const focusedHeading = (page: Page) => page.locator('section.step h2');

/** Waits for the step in focus to be `title`, numbered `number`. */
const focusIs = async (page: Page, number: number, title: string) => {
  await focusedHeading(page).filter({ hasText: title }).waitFor();
  return (
    (await focusedHeading(page).innerText()).replace(/\s+/g, ' ').trim() === `${number} ${title}` &&
    (await outlineItem(page, number - 1).getAttribute('aria-current')) === 'step'
  );
};

/** Waits for the outline's line `index` to read `word`: the page has read the plan again. */
const wordIs = (page: Page, index: number, word: string) =>
  outlineItem(page, index).locator('.outline-word').filter({ hasText: word }).waitFor();

const wordOf = async (page: Page, index: number) =>
  (await outlineItem(page, index).locator('.outline-word').innerText()).trim();

/** A plan of three steps, decided one by one: create, reject with a note, then the values. */
const setUpTheWorker = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const plan = askPlan(
    laptop,
    {
      reason: 'set up the new worker',
      steps: [
        { type: 'environments', items: [{ op: 'create', environment: 'acme/worker/staging' }] },
        {
          type: 'access',
          reason: 'deploy the worker from this session',
          name: 'Deploy the worker',
          read: ['acme/worker/staging', 'acme/app/production'],
          expires: '1h',
        },
        {
          type: 'secrets',
          items: [
            {
              op: 'set',
              environment: 'acme/worker/staging',
              name: 'CLOUDFLARE_ACCOUNT_ID',
              from: { file: '$DIR/account-id' },
            },
            {
              op: 'set',
              environment: 'acme/worker/staging',
              name: 'SENTRY_DSN',
              from: { file: '$DIR/sentry' },
            },
            { op: 'generate', environment: 'acme/worker/staging', name: 'SESSION_SECRET' },
            {
              op: 'paste',
              environment: 'acme/app/production',
              name: 'STRIPE_SECRET_KEY',
              hint: 'Stripe dashboard, Developers, API keys',
            },
            { op: 'paste', environment: 'acme/app/production', name: 'RESEND_API_KEY' },
          ],
        },
      ],
    },
    { 'account-id': ACCOUNT_ID, sentry: SENTRY_DSN },
  );
  check('`baymutt ask` prints the plan page’s link', plan.url.includes('/orgs/acme/ask/'));

  await page.goto(`${WEB}/orgs/acme/plans`);
  await page.getByRole('heading', { name: 'Plans', exact: true }).waitFor();
  await page.locator('.row-wait').first().waitFor();
  check(
    'Plans lists the waiting plan with its steps, and the nav counts it',
    (await page.getByText('“set up the new worker”').count()) === 1 &&
      (await page.locator('.row-wait .about').count()) === 3 &&
      (await page.locator('.nav-item[aria-current] .nav-count').innerText()).startsWith('1'),
  );
  await shoot(page, 'p01-plans');
  await page.getByRole('link', { name: 'Review' }).click();
  await page.getByRole('heading', { name: '“set up the new worker”' }).waitFor();
  check('Review opens the plan’s own page', page.url() === plan.url);
  check(
    'the plan opens on step 1, with the outline saying what waits for it',
    (await focusIs(page, 1, 'Create an environment')) &&
      (await wordOf(page, 1)) === 'waits for step 1' &&
      (await wordOf(page, 2)) === 'waits for step 1' &&
      (await page.title()) === 'Plan: set up the new worker · Acme · baymutt' &&
      (await page.locator('.dbar-back').innerText()).replace(/\s+/g, ' ') === 'Plans 1 waiting',
  );
  await shoot(page, 'p02-plan');
  await shootPhone(page, 'p02b-plan-phone');

  await outlineItem(page, 2).click();
  check(
    'any line of the outline opens its step; one that waits says why its Approve is closed',
    (await focusIs(page, 3, 'Change 5 secrets in 2 environments')) &&
      (await page.getByRole('button', { name: 'Approve 5 secret changes' }).isDisabled()) &&
      (await page
        .getByText('You can approve when step 1 is approved and both values are pasted.')
        .count()) === 1,
  );
  check(
    'the proposed values open in this browser, masked with their size',
    (await page
      .getByRole('button', { name: 'Reveal proposed value for CLOUDFLARE_ACCOUNT_ID' })
      .count()) === 1 &&
      (await page.getByText('32 B').count()) === 1 &&
      !(await page.content()).includes(ACCOUNT_ID),
  );
  check(
    'a paste item’s hint, sealed by the CLI, opens in this browser under its field',
    (await page.getByText('Where to find it: Stripe dashboard, Developers, API keys').count()) ===
      1,
  );
  await shoot(page, 'p03-plan-ahead');
  await shootPhone(page, 'p03b-plan-ahead-phone');

  await outlineItem(page, 0).click();
  await page.getByRole('button', { name: 'Create environment' }).click();
  await wordIs(page, 0, 'created');
  check(
    'creating the environment moves focus to the next step, which no longer waits',
    (await focusIs(page, 2, 'New key: Deploy the worker')) &&
      (await wordOf(page, 0)) === 'created' &&
      (await page.getByRole('button', { name: 'Approve key' }).isEnabled()) &&
      (await shownInEnds(page)) === '1 hour after approval, as asked',
  );
  await page.getByRole('button', { name: 'Add a note' }).click();
  await page.getByLabel('Note to Work laptop').fill('x'.repeat(2049));
  check(
    'a note over 2 KiB is refused in its field, and holds the answer back',
    (await page.getByText('The note can be at most 2,048 bytes; this is 2,049 bytes.').count()) ===
      1 && (await page.getByRole('button', { name: 'Reject', exact: true }).isDisabled()),
  );
  await page.getByLabel('Note to Work laptop').fill(NOTE);
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await wordIs(page, 1, 'rejected');
  check(
    'rejecting moves focus to the next step that can be answered',
    (await focusIs(page, 3, 'Change 5 secrets in 2 environments')) &&
      (await wordOf(page, 1)) === 'rejected' &&
      (await page.getByText('You can approve when both values are pasted.').count()) === 1,
  );
  await shoot(page, 'p04-plan-next');
  await shootPhone(page, 'p04b-plan-next-phone');

  await outlineItem(page, 1).click();
  await focusIs(page, 2, 'New key: Deploy the worker');
  check(
    'a step answered here, opened again, shows its answer and its note, and no buttons',
    /^Rejected just now\.$/.test((await page.locator('.step-status').innerText()).trim()) &&
      (await page.getByText(`Your note: “${NOTE}”`).count()) === 1 &&
      (await page.locator('section.step button').count()) === 0,
  );
  await shoot(page, 'p05-plan-decided');

  await outlineItem(page, 2).click();
  await page
    .getByRole('button', { name: 'Reveal proposed value for CLOUDFLARE_ACCOUNT_ID' })
    .click();
  check('Reveal shows the proposed value', (await page.getByText(ACCOUNT_ID).count()) === 1);
  await page.getByLabel('STRIPE_SECRET_KEY').fill(STRIPE_KEY);
  await page.getByLabel('RESEND_API_KEY').fill(RESEND_KEY);
  await shoot(page, 'p06-plan-values');
  await page.getByRole('button', { name: 'Approve 5 secret changes' }).click();
  await page.getByRole('heading', { name: 'Plan answered' }).waitFor();
  check(
    'once every step is answered, the plan says so with each step’s result',
    (await page.locator('.outline-word').allInnerTexts()).join(',') === 'created,rejected,approved',
  );
  await shoot(page, 'p07-plan-answered');

  const waited = waitPlan(laptop, plan.id);
  check(
    '`ask wait` prints each step, with the owner’s note opened by the login, and exits 4 on a rejection',
    waited.status === 4 &&
      waited.steps.map(({ status }) => status).join(',') === 'approved,rejected,approved' &&
      waited.steps[1]?.note === NOTE &&
      waited.steps[2]?.note === undefined,
  );
  const names = (environment: string) =>
    (laptop.cli(['secret', 'list', environment]).json?.secrets ?? []).map(
      (secret: { name: string }) => secret.name,
    );
  check(
    'the approved step wrote every value, each to its environment',
    ['CLOUDFLARE_ACCOUNT_ID', 'SENTRY_DSN', 'SESSION_SECRET'].every(name =>
      names('acme/worker/staging').includes(name),
    ) &&
      ['STRIPE_SECRET_KEY', 'RESEND_API_KEY'].every(name =>
        names('acme/app/production').includes(name),
      ),
  );
  return plan;
};

const shownInEnds = (page: Page) =>
  page.getByRole('combobox', { name: 'Ends', exact: true }).innerText();

/** A step that needs an environment an earlier step was to create, once that step is rejected. */
const rejectedDependency = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const plan = askPlan(laptop, {
    reason: 'add a preview',
    steps: [
      { type: 'environments', items: [{ op: 'create', environment: 'acme/worker/preview' }] },
      {
        type: 'secrets',
        items: [{ op: 'generate', environment: 'acme/worker/preview', name: 'PREVIEW_TOKEN' }],
      },
    ],
  });
  await page.goto(plan.url);
  await focusIs(page, 1, 'Create an environment');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await wordIs(page, 1, 'reject only');
  check(
    'once the step it needed is rejected, a step is blocked, and focus moves to it',
    (await focusIs(page, 2, 'Change a secret')) &&
      (await wordOf(page, 1)) === 'reject only' &&
      (await page
        .locator('.warnline')
        .innerText()
        .then(text =>
          text.startsWith(
            'Step 1 was rejected, so acme/worker/preview is unavailable. This step can only be rejected.',
          ),
        )) &&
      (await page.locator('.step-answer .btn.primary, .step-answer .btn.danger').count()) === 0,
  );
  await shoot(page, 'p08-plan-rejected-dependency');
  await shootPhone(page, 'p08b-plan-rejected-dependency-phone');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByRole('heading', { name: 'Plan answered' }).waitFor();
};

/** One step: no outline. Approved with a shorter end than asked; the key file reads. */
const oneStep = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const plan = askPlan(laptop, {
    reason: 'check the Stripe webhook config',
    steps: [
      {
        type: 'access',
        name: 'Stripe webhook check',
        read: ['acme/app/production'],
        expires: '1h',
      },
    ],
  });
  await page.goto(plan.url);
  await page.getByRole('heading', { name: '“check the Stripe webhook config”' }).waitFor();
  check(
    'a plan of one step has no outline, and reads as its one decision',
    (await page.locator('.outline').count()) === 0 &&
      (await page.locator('.ask').innerText()) ===
        'Work laptop asks for a new key, Stripe webhook check' &&
      (await page.title()) === 'New key: Stripe webhook check · Acme · baymutt',
  );
  await shoot(page, 'p09-plan-one');
  await shootPhone(page, 'p09b-plan-one-phone');
  await pick(page, 'Ends', /^15 minutes after approval/);
  await page.getByRole('button', { name: 'Approve key' }).click();
  await page.getByRole('heading', { name: 'Plan answered' }).waitFor();
  const waited = waitPlan(laptop, plan.id);
  const [step] = waited.steps;
  check(
    'the terminal gets the key file, ending when the owner chose',
    waited.status === 0 &&
      typeof step?.keyFile === 'string' &&
      typeof step?.expiresAt === 'number' &&
      Math.abs(step.expiresAt - (Date.now() + 15 * MINUTE_MS)) < 2 * MINUTE_MS,
  );
  const keyFile = step?.keyFile ?? fail('no key file');
  const agentEnv = { ...laptop.env, BAYMUTT_KEY_FILE: keyFile };
  const loaded = varlockLoads(agentEnv, 'acme/app/production', { STRIPE_SECRET_KEY: STRIPE_KEY });
  check(
    `the approved key reads the value pasted on the plan page${loaded.isLoaded ? '' : `: ${loaded.stderr}`}`,
    loaded.isLoaded,
  );
  const [made] = d1(`SELECT key_id FROM plan_step WHERE plan_id = ${sqlText(plan.id)}`);
  const keyId =
    typeof made?.key_id === 'string' ? made.key_id : fail('the access step made no key');
  return { keyId, agentEnv };
};

/** A change to that key: it adds read on the environment the first plan made. */
const changeTheKey = async ({
  laptop,
  page,
  keyId,
  agentEnv,
}: Pick<Run, 'laptop' | 'page'> & {
  readonly keyId: string;
  readonly agentEnv: NodeJS.ProcessEnv;
}) => {
  const plan = askPlan(laptop, {
    reason: 'check the worker’s account too',
    steps: [{ type: 'change', key: keyId, read: ['acme/worker/staging'] }],
  });
  await page.goto(plan.url);
  await page.getByRole('heading', { name: '“check the worker’s account too”' }).waitFor();
  check(
    'a change shows what the key reads now and what it adds, and keeps its end by default',
    (await page.getByText('Already reads').count()) === 1 &&
      (await page.getByText('Add read access').count()) === 1 &&
      (await shownInEnds(page)).startsWith('Keep as it is: expires in'),
  );
  await page.getByRole('button', { name: 'Approve change' }).click();
  await page.getByRole('heading', { name: 'Plan answered' }).waitFor();
  check('`ask wait` finishes the change', waitPlan(laptop, plan.id).status === 0);
  const loaded = varlockLoads(agentEnv, 'acme/worker/staging', {
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID,
  });
  check(
    `the changed key reads the value the first plan proposed, as the owner's browser sealed it${loaded.isLoaded ? '' : `: ${loaded.stderr}`}`,
    loaded.isLoaded,
  );
};

/** A proposed value the store moved to another secret does not open, and blocks its step. */
const unverifiedValue = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const plan = askPlan(
    laptop,
    {
      reason: 'set the mail keys',
      steps: [
        {
          type: 'secrets',
          items: [
            {
              op: 'set',
              environment: 'acme/app/production',
              name: 'MAIL_FROM',
              from: { file: '$DIR/a' },
            },
            {
              op: 'set',
              environment: 'acme/app/production',
              name: 'MAIL_REPLY_TO',
              from: { file: '$DIR/b' },
            },
          ],
        },
      ],
    },
    { a: 'noreply@example.test', b: 'support@example.test' },
  );
  // A store that swaps two proposals: each is bound to its own secret, so neither opens.
  d1(`UPDATE plan_item SET proposed_value = (
        SELECT proposed_value FROM plan_item WHERE plan_id = ${sqlText(plan.id)} AND position = 1)
      WHERE plan_id = ${sqlText(plan.id)} AND position = 0`);
  await page.goto(plan.url);
  await page.getByText('Proposed value could not be verified').waitFor();
  check(
    'a proposed value that does not open is shown as unverifiable, and the step is blocked',
    (await page.getByText('Proposed value could not be verified').count()) === 1 &&
      (await page.locator('.warnline').innerText()) ===
        'Your vault could not verify that the proposed value came from Work laptop. This step can only be rejected.' &&
      (await page.locator('.step-answer .btn.primary, .step-answer .btn.danger').count()) === 0,
  );
  await shoot(page, 'p10-plan-unverified');
  await page.getByRole('button', { name: 'Reject', exact: true }).click();
  await page.getByRole('heading', { name: 'Plan answered' }).waitFor();
};

/** A secret written after the page read it: refused, re-read, and approved again as typed. */
const writtenSince = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const plan = askPlan(laptop, {
    reason: 'rotate the Resend key',
    steps: [
      {
        type: 'secrets',
        items: [{ op: 'paste', environment: 'acme/app/production', name: 'RESEND_API_KEY' }],
      },
    ],
  });
  await page.goto(plan.url);
  await page.getByLabel('RESEND_API_KEY').fill(`${RESEND_KEY}-rotated`);
  await page.getByRole('button', { name: 'Add a note' }).click();
  await page.getByLabel('Note to Work laptop').fill('rotated');
  d1(`UPDATE secret SET latest_version = latest_version + 1
      WHERE (environment_id, name) = (
        SELECT environment_id, secret_name FROM plan_item WHERE plan_id = ${sqlText(plan.id)})`);
  await page.getByRole('button', { name: 'Approve secret change' }).click();
  await page
    .getByRole('alert')
    .filter({
      hasText:
        'Something changed since this plan was made. The plan has been refreshed; review the step and try again.',
    })
    .waitFor();
  check(
    'a secret written since the page read it is refused in place, and nothing typed is lost',
    (await page.getByLabel('RESEND_API_KEY').inputValue()) === `${RESEND_KEY}-rotated` &&
      (await page.getByLabel('Note to Work laptop').inputValue()) === 'rotated',
  );
  await shoot(page, 'p11-plan-written-since');
  await page.getByRole('button', { name: 'Approve secret change' }).click();
  await page.getByRole('heading', { name: 'Plan answered' }).waitFor();
  const waited = waitPlan(laptop, plan.id);
  check(
    'approved again, it goes through, with the note',
    waited.status === 0 && waited.steps[0]?.note === 'rotated',
  );
};

/** A long plan, drawn as it arrives, then withdrawn by its agent while the page is open. */
const withdrawn = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const plan = askPlan(laptop, {
    reason: 'hand CI its key and clean up',
    steps: [
      {
        type: 'access',
        name: 'App CI',
        read: ['acme/app/production'],
        command: ['node', '-e', 'process.stdin.resume()'],
      },
      {
        type: 'secrets',
        reason: 'the new token was rejected by Stripe',
        items: [
          {
            op: 'rollback',
            environment: 'acme/app/production',
            name: 'RESEND_API_KEY',
            version: 1,
          },
          { op: 'generate', environment: 'acme/app/production', name: 'WEBHOOK_SECRET' },
        ],
      },
      { type: 'environments', items: [{ op: 'delete', environment: 'acme/worker/staging' }] },
    ],
  });
  await page.goto(plan.url);
  await focusIs(page, 1, 'New key: App CI');
  check(
    'a key piped into a command is a service account, with no end as asked',
    (await page.getByText(/^The new service account key can only read\./).count()) === 1 &&
      (await shownInEnds(page)) === 'Never, as asked',
  );
  await shoot(page, 'p12-plan-service-account');
  await outlineItem(page, 2).click();
  check(
    'deleting an environment is the danger button, and says what follows',
    (
      await page.getByRole('button', { name: 'Delete environment' }).getAttribute('class')
    )?.includes('danger') === true &&
      (await page.getByText('The environment goes to the bin for 30 days.').count()) === 1,
  );
  check('`ask cancel` withdraws it', laptop.cli(['ask', 'cancel', plan.id]).status === 0);
  await page.getByRole('button', { name: 'Delete environment' }).click();
  await page.getByRole('heading', { name: 'Plan withdrawn' }).waitFor();
  check(
    'an answer to a withdrawn plan reads it again, and says it was withdrawn',
    (await page.locator('.outline-word').allInnerTexts()).join(',') ===
      'withdrawn,withdrawn,withdrawn',
  );
  await shoot(page, 'p13-plan-withdrawn');
};

/** A plan nobody answered within the hour. */
const expired = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  const plan = askPlan(laptop, {
    reason: 'make a scratch environment',
    steps: [{ type: 'environments', items: [{ op: 'create', environment: 'acme/scratch' }] }],
  });
  d1(`UPDATE plan SET created_at = created_at - 2 * 3600 * 1000 WHERE id = ${sqlText(plan.id)}`);
  await page.goto(plan.url);
  await page.getByRole('heading', { name: 'Plan expired' }).waitFor();
  check(
    'an expired plan says nobody answered it in time',
    (await page
      .getByText('Work laptop asked for it, and nobody answered step 1 within an hour.')
      .count()) === 1,
  );
  await shoot(page, 'p14-plan-expired');
  await shootPhone(page, 'p14b-plan-expired-phone');
};

/**
 * Every step type approved and rejected on the plan page, and what the terminal then reads. Leaves
 * the agent key it made and the env that loads with it for later steps.
 */
export const plans = async ({ laptop, page }: Pick<Run, 'laptop' | 'page'>) => {
  await setUpTheWorker({ laptop, page });
  await rejectedDependency({ laptop, page });
  const { keyId, agentEnv } = await oneStep({ laptop, page });
  await changeTheKey({ laptop, page, keyId, agentEnv });
  await unverifiedValue({ laptop, page });
  await writtenSince({ laptop, page });
  await withdrawn({ laptop, page });
  await expired({ laptop, page });
  await page.goto(`${WEB}/orgs/acme/plans`);
  await page.getByText('No plans waiting').waitFor();
  check('with nothing waiting, Plans shows its empty state', true);
  await shoot(page, 'p15-plans-empty');
  return { keyId };
};
