// The example account the page shows. The ids, keys, code and links were made by @baymutt/keys'
// own functions (a CLI login's token, its pairing code, an environment key's fingerprint), and every
// printed object has the shape the CLI prints, so a transcript here is one the CLI could print. A
// long one shows a few of its fields and an ellipsis for the rest.
// The page labels it an example.

import type { TerminalLine } from './terminal.ts';

export const ORIGIN = 'https://baymutt.fsh.ba';

export const ACCOUNT = {
  id: '7f391e28-bbe1-465b-87c4-1c22d95dbc29',
  name: 'Sam',
  publicKey: 'VkmsLMFeubPy67H6rOZGGhtxn6J9M8xVXMN__d4zRkE',
};

export const MACBOOK = { id: 'e5a0c3f2-6b1d-4c8e-9f27-3d4b5a6c7e81', name: 'MacBook' };

export const CI_DEPLOY = {
  id: '12f8eb12-b267-436c-913d-2b53c315bd88',
  name: 'CI deploy',
  publicKey: 'Tcapq1jCNhKW2wpCxxo9zNTPZ3EsZ9X2276lum0OEzQ',
};

export const MAC_MINI = {
  id: '22b9687b-1e40-4ed7-9971-c17ec5443f12',
  name: 'Mac mini',
  code: 'AJFS-6NY1',
};

export const ORG = { id: 'Qm7cT2vXa9LpD4sKw8NhB3yRf6GjZ1Ue', slug: 'acme' };

export const ENVIRONMENT = { id: 'ac1e0fa1-faed-4f81-bd8b-a1dcb12fe75f', name: 'app/production' };

/** How an environment is named wherever a name is taken: its org's slug, then its name. */
export const ADDRESS = `${ORG.slug}/${ENVIRONMENT.name}`;

const PAIR_URL = `${ORIGIN}/pair#%7B%22id%22%3A%2222b9687b-1e40-4ed7-9971-c17ec5443f12%22%2C%22name%22%3A%22Mac%20mini%22%2C%22publicKey%22%3A%22skZN7eF_FUvajVkUHQylJLLJ_ePuujf8FU4_dW4DHys%22%2C%22bearerHash%22%3A%22u_yVkseke_CFXhP6Buey1-RFphmICjoDoJ1LGknfxkc%22%2C%22pairingSecret%22%3A%22_cxzoocyt6mEEyw_d40_lUeGXfdBOPhxicJezFaSsGE%22%7D`;

const PASTE_ID = '26e29156-e4e0-4184-bcc8-bb3838019010';
const PASTE_URL = `${ORIGIN}/paste/${PASTE_ID}#0lufnXZECBJxIMQD0ogv9TAJFXQvlImpvE5PiKYyOjA.tIULg7BFELIuuzOD0jCFUl3YmqHbryqcF71CabEz4FU`;
const ASKED_AT = 1794390067512;
const MACBOOK_ACTOR = { kind: 'credential', id: MACBOOK.id, name: MACBOOK.name };

/** The first screen's: you install and log in, then an agent runs a command with its secrets. */
export const START: readonly TerminalLine[] = [
  { kind: 'command', by: 'you', text: 'npm install -g baymutt' },
  { kind: 'command', by: 'you', text: 'baymutt login' },
  { kind: 'command', by: 'agent', text: 'varlock run -- npm run dev' },
];

export const PAIR: readonly TerminalLine[] = [
  { kind: 'command', by: 'you', text: `baymutt login --name "${MAC_MINI.name}"` },
  {
    kind: 'stderr',
    text: `Ask the owner to open this link and approve it. The page must show the code ${MAC_MINI.code}.`,
    match: MAC_MINI.code,
  },
  { kind: 'stderr', text: PAIR_URL, isClipped: true },
  { kind: 'note', text: 'you open the link and approve' },
  {
    kind: 'stdout',
    value: { status: 'loggedIn', serviceAccountId: MAC_MINI.id, account: ACCOUNT },
    only: ['status'],
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
  { kind: 'command', by: 'agent', text: 'varlock run -- npm run dev' },
];

export const ROLLBACK: readonly TerminalLine[] = [
  { kind: 'command', by: 'agent', text: `baymutt rollback ${ADDRESS} SESSION_SECRET --to 3` },
  {
    kind: 'stdout',
    value: {
      name: 'SESSION_SECRET',
      currentVersion: 3,
      latestVersion: 4,
      size: 103,
      updatedAt: ASKED_AT,
      updatedBy: MACBOOK_ACTOR,
      purgeAt: null,
    },
    only: ['name', 'currentVersion', 'latestVersion'],
  },
];

export const PASTE_LINK: readonly TerminalLine[] = [
  {
    kind: 'command',
    by: 'agent',
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
    only: ['id', 'status'],
  },
  { kind: 'command', by: 'agent', text: `baymutt wait ${PASTE_ID}` },
  { kind: 'note', text: 'you paste it' },
  { kind: 'stdout', value: { id: PASTE_ID, status: 'answered' } },
];

export const SERVICE_ACCOUNT: readonly TerminalLine[] = [
  {
    kind: 'command',
    by: 'agent',
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

const STAGING = `${ORG.slug}/app/staging`;

export const WRITE: readonly TerminalLine[] = [
  { kind: 'command', by: 'agent', text: `baymutt generate ${ADDRESS} SESSION_SECRET` },
  {
    kind: 'stdout',
    value: { environment: ADDRESS, name: 'SESSION_SECRET', version: 4, length: 43 },
  },
  { kind: 'command', by: 'agent', text: `baymutt generate ${STAGING} SESSION_SECRET` },
  {
    // apps/cli/src/errors.ts: one line on stderr, a not-found usage error exits 5.
    kind: 'stderr',
    text: JSON.stringify({
      error: {
        code: 'UsageError',
        message: `None of your orgs has an environment ${STAGING}. See them with \`baymutt environments\`, or create it with \`baymutt environments create <org>/<name>\`.`,
        exitCode: 5,
      },
    }),
  },
];
