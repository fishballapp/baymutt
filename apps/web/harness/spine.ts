// Steps of the flow that belong to no one area: the shell's own screens, and a stretch that
// stores an org the 0.7 way with SQL and drives several areas' pages around it. Areas ask for
// changes here; each screen is still saved under the area that owns it, for `DRIVE_SHOTS`.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as environmentSteps from './areas/environments.ts';
import * as listSteps from './areas/lists.ts';
import {
  check,
  d1,
  fail,
  MINUTE_MS,
  type Run,
  sendAsk,
  shooter,
  sqlText,
  varlockLoads,
  WEB,
  waitAsk,
} from './support.ts';

const shell = shooter('shell');
const account = shooter('account');
const environments = shooter('environments');

/** An org stored the 0.7 way, sealed by the dashboard; a store that hides an org's names key; an org that is not the person's. */
export const legacyOrg = async ({ ci, laptop, page }: Pick<Run, 'ci' | 'laptop' | 'page'>) => {
  await page.getByLabel('Org name').fill('Legacy Ltd');
  await page.getByLabel('Slug').fill('legacy');
  await page.getByRole('button', { name: 'Create org' }).click();
  await environmentSteps.environmentsEmpty(page, 'Legacy Ltd');
  check('a new org opens at its own address', page.url() === `${WEB}/orgs/legacy/environments`);
  await page.goto(`${WEB}/account`);
  await page.getByRole('main').getByText('Legacy Ltd').waitFor();
  await account.shoot(page, '13e-account-orgs');
  await page.goto(`${WEB}/orgs/legacy/environments`);
  await environmentSteps.environmentsEmpty(page, 'Legacy Ltd');
  await environmentSteps.createEnvironment(page, 'app/legacy');
  await page.getByRole('link', { name: /legacy\/app\/legacy/ }).click();
  await environmentSteps.addSecret(page, 'LEGACY_TOKEN', 'legacy-value');
  const legacyCiKey = join(laptop.home, 'legacy-ci-key');
  const legacyAsk = sendAsk(laptop, {
    reason: 'CI: legacy deploy',
    steps: [
      {
        type: 'access',
        name: 'Legacy CI',
        read: ['legacy/app/legacy'],
        command: ['sh', '-c', `cat > ${legacyCiKey}`],
      },
    ],
  });
  await page.goto(legacyAsk.url);
  await page.getByRole('button', { name: 'Approve key' }).click();
  await page.getByRole('heading', { name: 'Ask answered' }).waitFor();
  waitAsk(laptop, legacyAsk.id);
  const legacyKeyId = String(
    d1(`SELECT key_id FROM ask_step WHERE ask_id = ${sqlText(legacyAsk.id)}`)[0]?.key_id,
  );
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
  await page.goto(`${WEB}/orgs/legacy/environments`);
  await environmentSteps.environmentsEmpty(page, 'Legacy Ltd');
  let sealed = false;
  for (let attempt = 0; attempt < 40 && !sealed; attempt++) {
    sealed = isSealed();
    if (!sealed) await page.waitForTimeout(250);
  }
  check('opening the dashboard seals the org’s names', sealed);
  check(
    'a service account whose environment there is in the bin gets the org’s names too',
    d1(`SELECT count(*) AS wraps FROM names_key_wrap
        WHERE org_id = ${org} AND reader_id = ${sqlText(legacyKeyId)}`)[0]?.wraps === 1,
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
  await environments.shoot(page, '13f-legacy-environment-sealed');
  check('the dashboard shows the sealed names', true);

  const keptWraps = d1(
    `SELECT reader_id, wrap, created_at FROM names_key_wrap WHERE org_id = ${org}`,
  );
  const [keptName] = d1(`SELECT name, sealed_name FROM environment WHERE id = ${environment}`);
  await page.goto('about:blank');
  d1(`DELETE FROM names_key_wrap WHERE org_id = ${org};
      UPDATE environment SET name = 'app/made-up', sealed_name = NULL WHERE id = ${environment};`);
  await page.goto(`${WEB}/orgs/legacy/environments`);
  await page.getByRole('link', { name: /legacy\/name does not open/ }).waitFor();
  await environmentSteps.createEnvironment(page, 'app/other');
  await page.getByText(/did not hand over this org’s names/).waitFor();
  await environments.shoot(page, '13g-names-withheld');
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
  await page.goto(`${WEB}/orgs/legacy/bin`);
  await page.getByRole('heading', { name: 'Bin' }).waitFor();
  await page.getByRole('button', { name: 'Org: Legacy Ltd' }).click();
  await page.getByRole('menuitemradio', { name: 'Acme' }).click();
  await page.waitForURL(`${WEB}/orgs/acme/bin`);
  check('the picker opens the same section of the org picked', true);
  await page.goto(`${WEB}/orgs/nobody/keys`);
  await page.getByRole('heading', { name: 'No org here' }).waitFor();
  await shell.shoot(page, '13h-org-not-found');
  check(
    'an org that is not the person’s is not found, with a way back',
    (await page.getByRole('link', { name: 'Go to your orgs' }).count()) === 1,
  );
  await page.goto(`${WEB}/orgs/legacy/environments/${legacyEnvironment.id}`);
  await page.getByText('LEGACY_TOKEN').waitFor();
  await page.goto(`${WEB}/orgs/acme/environments/${legacyEnvironment.id}`);
  await page.getByText('Acme has no environment with this id.').waitFor();
  check('an environment is shown only under its own org’s address', true);
  await page.goto(`${WEB}/orgs/acme/environments`);
  await page.getByRole('link', { name: /acme\/app\/production/ }).waitFor();

  // The last org shown is kept under its own name; the id an older dashboard kept is not read.
  await page.evaluate(() => localStorage.setItem('baymutt.org', 'legacy'));
  await page.goto(`${WEB}/orgs`);
  await page.waitForURL(`${WEB}/orgs/acme/environments`);
  check(
    '`/orgs` lands on the org last shown, kept as a slug under a new name',
    (await page.evaluate(() => localStorage.getItem('baymutt.lastOrgSlug'))) === 'acme',
  );
};

/** The dark scheme on the same passkey page. */
export const darkAndPhone = async ({ context, page }: Pick<Run, 'context' | 'page'>) => {
  // The same page: the virtual authenticator belongs to its target.
  await page.emulateMedia({ colorScheme: 'dark' });
  await environmentSteps.environmentDark(page);
  await listSteps.keysEmptyDark(page);
  await context.close();
};
