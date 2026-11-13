// The example account the page shows. The ids, keys, code and links were made by @baymutt/keys'
// own functions (a service account token, its pairing code, an environment key's fingerprint), and every
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

export const MAC_MINI = {
  id: '22b9687b-1e40-4ed7-9971-c17ec5443f12',
  name: 'Mac mini',
  code: 'AJFS-6NY1',
};

export const ENVIRONMENT = { id: 'ac1e0fa1-faed-4f81-bd8b-a1dcb12fe75f', name: 'app/production' };

const PAIR_URL = `${ORIGIN}/pair#%7B%22id%22%3A%2222b9687b-1e40-4ed7-9971-c17ec5443f12%22%2C%22name%22%3A%22Mac%20mini%22%2C%22publicKey%22%3A%22skZN7eF_FUvajVkUHQylJLLJ_ePuujf8FU4_dW4DHys%22%2C%22bearerHash%22%3A%22u_yVkseke_CFXhP6Buey1-RFphmICjoDoJ1LGknfxkc%22%2C%22pairingSecret%22%3A%22_cxzoocyt6mEEyw_d40_lUeGXfdBOPhxicJezFaSsGE%22%7D`;

const PASTE_ID = '26e29156-e4e0-4184-bcc8-bb3838019010';
const PASTE_URL = `${ORIGIN}/paste/${PASTE_ID}#0lufnXZECBJxIMQD0ogv9TAJFXQvlImpvE5PiKYyOjA.tIULg7BFELIuuzOD0jCFUl3YmqHbryqcF71CabEz4FU`;
const ASKED_AT = 1794390067512;

export const PAIR: readonly TerminalLine[] = [
  { kind: 'command', text: 'npm install -g baymutt' },
  { kind: 'command', text: `baymutt login --name "${MAC_MINI.name}"` },
  {
    kind: 'stderr',
    text: `Ask the owner to open this link and approve it. The page must show the code ${MAC_MINI.code}.`,
  },
  { kind: 'stderr', text: PAIR_URL, isClipped: true },
  {
    kind: 'stdout',
    value: { status: 'loggedIn', serviceAccountId: MAC_MINI.id, account: ACCOUNT },
  },
];

export const SCHEMA_FILE = [
  '# @plugin(@baymutt/varlock-plugin)',
  '# @initBaymutt(key=$BAYMUTT_KEY)',
  `# @setValuesBulk(baymuttLoad("${ENVIRONMENT.name}"))`,
  '# ---',
  'DATABASE_URL=',
  'SESSION_SECRET=',
  'RESEND_API_KEY=',
  'STRIPE_SECRET_KEY=',
];

export const WRITE: readonly TerminalLine[] = [
  { kind: 'command', text: `baymutt generate ${ENVIRONMENT.name} SESSION_SECRET` },
  {
    kind: 'stdout',
    value: { environment: ENVIRONMENT.name, name: 'SESSION_SECRET', version: 4, length: 43 },
  },
];

export const REQUEST: readonly TerminalLine[] = [
  {
    kind: 'command',
    text: `baymutt request ${ENVIRONMENT.name} RESEND_API_KEY --reason "to send sign-in emails" --where "Resend dashboard, API Keys"`,
  },
  {
    kind: 'stderr',
    text: 'Ask the owner to open this link and paste RESEND_API_KEY. It works once, for 15 minutes; after that the request is in the dashboard.',
  },
  {
    kind: 'stdout',
    value: {
      id: PASTE_ID,
      environmentId: ENVIRONMENT.id,
      environmentName: ENVIRONMENT.name,
      name: 'RESEND_API_KEY',
      reason: 'to send sign-in emails',
      hint: 'Resend dashboard, API Keys',
      status: 'pending',
      createdBy: { kind: 'machine', id: MACBOOK.id, name: MACBOOK.name },
      createdAt: ASKED_AT,
      linkExpiresAt: ASKED_AT + 15 * 60_000,
      url: PASTE_URL,
    },
    only: ['id', 'name', 'status', 'url'],
  },
  { kind: 'command', text: `baymutt wait ${PASTE_ID}` },
  { kind: 'stdout', value: { id: PASTE_ID, status: 'answered' } },
];

export const SERVICE_ACCOUNT_COMMAND = `baymutt service-accounts create --name "CI deploy" --read ${ENVIRONMENT.name} -- gh secret set BAYMUTT_KEY`;
