// The example account the page shows. The ids, keys and links were made by @baymutt/keys' own
// functions, and every printed object has the shape the CLI prints, so a transcript here is one the
// CLI could print. A long one shows a few of its fields and an ellipsis for the rest.

import type { TerminalLine } from './terminal.ts';

const ORIGIN = 'https://baymutt.fsh.ba';

const MACBOOK = { id: 'e5a0c3f2-6b1d-4c8e-9f27-3d4b5a6c7e81', name: 'MacBook' };

/** The key an agent asked for to run a migration, approved for an hour. */
const MIGRATION_KEY = { id: '7b3d9e41-2c8a-4f56-a1e0-58c4d2b9f603' };

/** The key a CLI login asked for on behalf of CI, approved with no end. */
const CI_DEPLOY = { id: '12f8eb12-b267-436c-913d-2b53c315bd88' };

const ORG = { id: 'Qm7cT2vXa9LpD4sKw8NhB3yRf6GjZ1Ue', slug: 'acme' };

const ENVIRONMENT = { id: 'ac1e0fa1-faed-4f81-bd8b-a1dcb12fe75f', name: 'app/production' };

/** How an environment is named wherever a name is taken: its org's slug, then its name. */
const ADDRESS = `${ORG.slug}/${ENVIRONMENT.name}`;

const PASTE_ID = '26e29156-e4e0-4184-bcc8-bb3838019010';
const ASKED_AT = 1794390067512;
const MACBOOK_ACTOR = { kind: 'credential', id: MACBOOK.id, name: MACBOOK.name };

const KEY_FILE = `/Users/agent/.config/baymutt/baymutt.fsh.ba/keys/${MIGRATION_KEY.id}`;

/** Getting started: an agent installs and logs in once per computer, and you approve. */
export const START: readonly TerminalLine[] = [
  { kind: 'command', text: 'npm install -g baymutt' },
  { kind: 'command', text: 'baymutt auth login' },
  { kind: 'note', text: 'you open the link and approve' },
];

/** An agent asks for one environment, for an hour; you approve, and it gets a key of its own. */
export const ASK: readonly TerminalLine[] = [
  {
    kind: 'command',
    text: `baymutt ask access --read ${ADDRESS} --reason "run the migration" --expires 1h`,
  },
  {
    kind: 'stdout',
    value: {
      id: MIGRATION_KEY.id,
      status: 'pending',
      url: `${ORIGIN}/requests/${MIGRATION_KEY.id}`,
      next: `Give the owner the link: the request waits an hour for them. Then run \`baymutt ask wait ${MIGRATION_KEY.id}\`.`,
    },
    only: ['status', 'url'],
  },
  { kind: 'note', text: 'you open the link and approve' },
  { kind: 'command', text: `baymutt ask wait ${MIGRATION_KEY.id}` },
  {
    kind: 'stdout',
    value: {
      id: MIGRATION_KEY.id,
      status: 'approved',
      keyFile: KEY_FILE,
      expiresAt: ASKED_AT + 3600_000,
      environments: [{ environment: ADDRESS, canRead: true, canWrite: false }],
    },
    only: ['status', 'environments'],
  },
];

export const SCHEMA_FILE = [
  '# @plugin(@baymutt/varlock-plugin)',
  '# @initBaymutt(key=$BAYMUTT_KEY)',
  `# @setValuesBulk(baymuttLoad("${ADDRESS}"))`,
  '# ---',
  'DATABASE_URL=',
  'SESSION_SECRET=',
  'RESEND_API_KEY=',
];

export const LOAD: readonly TerminalLine[] = [
  { kind: 'command', text: `BAYMUTT_KEY_FILE=${KEY_FILE} varlock run -- pnpm migrate` },
];

export const PASTE_LINK: readonly TerminalLine[] = [
  {
    kind: 'command',
    text: `baymutt ask paste-link ${ADDRESS} RESEND_API_KEY --reason "to send sign-in emails" --where "Resend dashboard, API Keys"`,
  },
  {
    kind: 'stderr',
    text: `Ask the owner to open this link and paste RESEND_API_KEY. It works once, for an hour; the owner can also answer it in the dashboard, under Paste links. Then run \`baymutt ask wait ${PASTE_ID}\`.`,
  },
  {
    kind: 'stdout',
    value: {
      id: PASTE_ID,
      orgId: ORG.id,
      orgSlug: ORG.slug,
      environmentId: ENVIRONMENT.id,
      reason: 'to send sign-in emails',
      hint: 'Resend dashboard, API Keys',
      status: 'pending',
      createdBy: MACBOOK_ACTOR,
      createdAt: ASKED_AT,
      environment: ADDRESS,
      name: 'RESEND_API_KEY',
      url: `${ORIGIN}/paste/${PASTE_ID}`,
    },
    only: ['status'],
  },
  { kind: 'command', text: `baymutt ask wait ${PASTE_ID}` },
  { kind: 'note', text: 'you paste it' },
  { kind: 'stdout', value: { id: PASTE_ID, status: 'fulfilled' } },
];

/** A key for CI: asked for like any other, piped into a command once approved, never shown. */
export const CI_KEY: readonly TerminalLine[] = [
  {
    kind: 'command',
    text: `baymutt ask access --read ${ADDRESS} --reason "CI: deploy" -- gh secret set BAYMUTT_KEY`,
  },
  { kind: 'note', text: 'you approve it, with no end' },
  { kind: 'command', text: `baymutt ask wait ${CI_DEPLOY.id}` },
  {
    kind: 'stdout',
    value: {
      id: CI_DEPLOY.id,
      status: 'approved',
      piped: true,
      command: 'gh secret set BAYMUTT_KEY',
      exitCode: 0,
      expiresAt: null,
      environments: [{ environment: ADDRESS, canRead: true, canWrite: false }],
    },
    only: ['status', 'command', 'exitCode'],
  },
];
