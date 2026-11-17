/** Migration 0003: a key's intent, written from its request's command, and from its end when it has no request. */
import { fileURLToPath } from 'node:url';
import { createTestD1 } from '@internal/effect-worker/testing';
import { expect, it } from 'vitest';

const migrationsDir = fileURLToPath(new URL('../../migrations', import.meta.url).href);

const NOW = 1_700_000_000_000;

it('backfills a key from its request’s command, else from whether it ends, and leaves a CLI login empty', () => {
  const { sqlite } = createTestD1({
    migrationsDir,
    legacy: {
      before: '0003',
      seed: db => {
        db.exec(`
          INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
            VALUES ('u', 'u', 'u@example.test', 1, 'now', 'now');
          INSERT INTO store_account (id, user_id, name, public_key, encrypted_private_key,
            recovery_wrapped_dek, vault_proof_hash, created_at)
            VALUES ('a', 'u', 'u', 'pk', 'sk', 'dek', 'proof', ${NOW});
          INSERT INTO credential (id, account_id, name, public_key, bearer_hash, parent_id, created_at, expires_at)
            VALUES ('login', 'a', 'laptop', 'pk', 'h', NULL, ${NOW}, NULL),
                   ('piped', 'a', 'piped', 'pk', 'h', 'login', ${NOW}, ${NOW + 3_600_000}),
                   ('kept', 'a', 'kept', 'pk', 'h', 'login', ${NOW}, NULL),
                   ('old-open', 'a', 'old-open', 'pk', 'h', 'login', ${NOW}, NULL),
                   ('old-ends', 'a', 'old-ends', 'pk', 'h', 'login', ${NOW}, ${NOW + 3_600_000});
          INSERT INTO access_request (credential_id, status, command, lifetime, created_at)
            VALUES ('piped', 'approved', 'gh secret set BAYMUTT_KEY', 3600000, ${NOW}),
                   ('kept', 'approved', NULL, NULL, ${NOW});
        `);
      },
    },
  });
  const intents = Object.fromEntries(
    (
      sqlite.prepare('SELECT id, intent FROM credential').all() as {
        id: string;
        intent: string | null;
      }[]
    ).map(({ id, intent }) => [id, intent]),
  );
  expect(intents).toEqual({
    login: null,
    // From the request: a command makes a service account whether or not it ends, and no command
    // an agent key whether or not it ends.
    piped: 'service-account',
    kept: 'agent',
    // No request row (made before 0.8.0): by the end it has.
    'old-open': 'service-account',
    'old-ends': 'agent',
  });
});
