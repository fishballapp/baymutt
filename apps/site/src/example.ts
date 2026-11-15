// The example account the page shows. The ids, keys and links were made by @baymutt/keys' own
// functions, and every printed object has the shape the CLI prints, so a transcript here is one the
// CLI could print. A long one shows a few of its fields and an ellipsis for the rest.

import type { TerminalLine } from './terminal.ts';

const ORIGIN = 'https://baymutt.fsh.ba';

const MACBOOK = { id: 'e5a0c3f2-6b1d-4c8e-9f27-3d4b5a6c7e81', name: 'MacBook' };

const CI_DEPLOY = {
  id: '12f8eb12-b267-436c-913d-2b53c315bd88',
  name: 'CI deploy',
  publicKey: 'Tcapq1jCNhKW2wpCxxo9zNTPZ3EsZ9X2276lum0OEzQ',
};

const ORG = { id: 'Qm7cT2vXa9LpD4sKw8NhB3yRf6GjZ1Ue', slug: 'acme' };

const ENVIRONMENT = { id: 'ac1e0fa1-faed-4f81-bd8b-a1dcb12fe75f', name: 'app/production' };

/** How an environment is named wherever a name is taken: its org's slug, then its name. */
const ADDRESS = `${ORG.slug}/${ENVIRONMENT.name}`;

const PASTE_ID = '26e29156-e4e0-4184-bcc8-bb3838019010';
const PASTE_URL = `${ORIGIN}/paste/${PASTE_ID}#0lufnXZECBJxIMQD0ogv9TAJFXQvlImpvE5PiKYyOjA.tIULg7BFELIuuzOD0jCFUl3YmqHbryqcF71CabEz4FU`;
const ASKED_AT = 1794390067512;
const MACBOOK_ACTOR = { kind: 'credential', id: MACBOOK.id, name: MACBOOK.name };

/** Getting started: an agent installs and logs in, you approve, and it runs a command with its secrets. */
export const START: readonly TerminalLine[] = [
  { kind: 'command', text: 'npm install -g baymutt' },
  { kind: 'command', text: 'baymutt login' },
  { kind: 'note', text: 'you open the link and approve' },
  { kind: 'command', text: 'varlock run -- npm run dev' },
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

export const PASTE_LINK: readonly TerminalLine[] = [
  {
    kind: 'command',
    text: `baymutt paste-link ${ADDRESS} RESEND_API_KEY --reason "to send sign-in emails" --where "Resend dashboard, API Keys"`,
  },
  {
    kind: 'stderr',
    text: 'Ask the owner to open this link and paste RESEND_API_KEY. It works once, for 15 minutes; after that it is in the dashboard, under Paste links.',
  },
  {
    kind: 'stdout',
    value: {
      id: PASTE_ID,
      orgId: ORG.id,
      orgSlug: ORG.slug,
      environmentId: ENVIRONMENT.id,
      environmentName: ENVIRONMENT.name,
      name: 'RESEND_API_KEY',
      reason: 'to send sign-in emails',
      hint: 'Resend dashboard, API Keys',
      status: 'pending',
      createdBy: MACBOOK_ACTOR,
      createdAt: ASKED_AT,
      linkExpiresAt: ASKED_AT + 15 * 60_000,
      url: PASTE_URL,
    },
    only: ['status'],
  },
  { kind: 'command', text: `baymutt wait ${PASTE_ID}` },
  { kind: 'note', text: 'you paste it' },
  { kind: 'stdout', value: { id: PASTE_ID, status: 'answered' } },
];

export const SERVICE_ACCOUNT: readonly TerminalLine[] = [
  {
    kind: 'command',
    text: `baymutt service-accounts create --name "${CI_DEPLOY.name}" --read ${ADDRESS} -- gh secret set BAYMUTT_KEY`,
  },
  {
    kind: 'stdout',
    value: {
      id: CI_DEPLOY.id,
      name: CI_DEPLOY.name,
      publicKey: CI_DEPLOY.publicKey,
      parentId: MACBOOK.id,
      description: null,
      expiresAt: null,
      endorsement: null,
      keyVoucher: null,
      createdAt: ASKED_AT,
      lastUsedAt: null,
      grants: [
        {
          environmentId: ENVIRONMENT.id,
          orgSlug: ORG.slug,
          environmentName: ENVIRONMENT.name,
          canRead: true,
          canWrite: false,
        },
      ],
    },
    only: ['id', 'name', ['grants', ['environmentName', 'canRead', 'canWrite']]],
  },
];

export const WRITE: readonly TerminalLine[] = [
  { kind: 'command', text: `baymutt generate ${ADDRESS} SESSION_SECRET` },
  {
    kind: 'stdout',
    value: { environment: ADDRESS, name: 'SESSION_SECRET', version: 4, length: 43 },
  },
];
