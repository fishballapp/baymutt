// `baymutt login`: makes a service account key and asks the owner to approve it. Run it again to
// finish: it picks up where it left off. `baymutt logout` undoes it.
import { hostname } from 'node:os';
import { LabelSchema, PairingRequestSchema } from '@baymutt/api';
import { generateServiceAccountToken, openWelcome, pairingCode, randomToken } from '@baymutt/keys';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { aboutFlags, aboutPayload } from '../about.ts';
import { crypto_, report, usage } from '../errors.ts';
import { KeyStore } from '../key-store.ts';
import { print, say } from '../output.ts';
import { serviceAccountFromToken } from '../service-account.ts';
import { readState, removeState, Settings, updateState } from '../settings.ts';

const PairingFragmentSchema = Schema.fromJsonString(PairingRequestSchema);

const POLL_EVERY = Duration.seconds(2);

/** "CLI on <this computer's name>", within a name's 60 characters. */
const defaultName = () => `CLI on ${hostname().slice(0, 53).trim() || 'this computer'}`;

/** The service account's key: the one already kept when a pairing is under way, or a new one. */
const serviceAccountToken = Effect.gen(function* () {
  const store = yield* KeyStore;
  const kept = yield* store.read;
  if (Option.isSome(kept)) return kept.value;
  const token = Redacted.make(generateServiceAccountToken());
  yield* store.write(token);
  return token;
});

export const loginCommand = Command.make(
  'login',
  {
    name: Flag.String('name').pipe(
      Flag.withDescription(
        'What the owner will see this login as. Default: "CLI on <this computer’s name>"',
      ),
      Flag.withSchema(LabelSchema),
      Flag.optional,
    ),
    ...aboutFlags,
    wait: Flag.Int('wait').pipe(
      Flag.withDescription(
        'Seconds to wait for the owner’s approval before returning (0 to return at once)',
      ),
      Flag.withDefault(300),
    ),
  },
  Effect.fn('login')(function* ({ name, wait, description, expires }) {
    const { origin } = yield* Settings;
    const { key, api } = yield* serviceAccountFromToken(yield* serviceAccountToken);
    const state = yield* readState;

    if (state.account !== undefined) {
      // Ask the store: a login revoked or expired since is not logged in, whatever this computer kept.
      yield* api.credentials.me();
      return yield* print({
        status: 'loggedIn',
        serviceAccountId: key.credentialId,
        account: state.account,
      });
    }

    // What the link says is fixed when it is first printed: running again prints the same link.
    const pending = state.pendingPairing ?? {
      pairingSecret: randomToken(),
      name: Option.getOrElse(name, defaultName),
      ...(yield* aboutPayload({ description, expires })),
    };
    yield* updateState(current => ({ ...current, pendingPairing: pending }));

    const fragment = yield* Schema.encodeEffect(PairingFragmentSchema)({
      id: key.credentialId,
      name: pending.name,
      publicKey: key.publicKey,
      bearerHash: key.bearerHash,
      pairingSecret: pending.pairingSecret,
      ...(pending.description === undefined ? {} : { description: pending.description }),
      ...(pending.expiresAt === undefined ? {} : { expiresAt: pending.expiresAt }),
    }).pipe(Effect.orDie);
    const url = `${origin}/pair#${encodeURIComponent(fragment)}`;
    const code = yield* crypto_(() => pairingCode(key.publicKey));

    // Approved once the store recognises the bearer; until then it answers 401.
    const approved = api.credentials.me().pipe(
      Effect.asSome,
      Effect.catchTag('UnauthorizedError', () => Effect.succeedNone),
    );
    const poll = approved.pipe(
      Effect.repeat({
        schedule: Schedule.spaced(POLL_EVERY),
        until: Option.isSome,
      }),
      Effect.timeoutOption(Duration.seconds(wait)),
      Effect.map(Option.flatten),
    );

    const first = yield* approved;
    if (Option.isNone(first)) {
      yield* say(
        `Ask the owner to open this link and approve it. The page must show the code ${code}.`,
      );
      yield* say(url);
    }
    const me = Option.isSome(first) || wait === 0 ? first : yield* poll;
    if (Option.isNone(me)) {
      return yield* print({
        status: 'pending',
        serviceAccountId: key.credentialId,
        code,
        url,
        next: 'Run `baymutt login` again once the owner has approved it.',
      });
    }

    const welcome = me.value.credential?.welcome;
    if (welcome === null || welcome === undefined) {
      return yield* usage(
        'The store knows this service account key but has no answer from a browser that approved its login. Use a service account key made by `baymutt login`.',
        'integrity',
      );
    }
    // Sealed by the owner's browser under a secret the store never saw: this is where the service account
    // learns which account key to trust.
    const account = yield* crypto_(() =>
      openWelcome(
        {
          pairingSecret: pending.pairingSecret,
          credentialId: key.credentialId,
          serviceAccountPublicKey: key.publicKey,
        },
        welcome,
      ),
    );
    if (account.accountId !== me.value.accountId) {
      return yield* usage(
        'The browser approved this login for one account and the store answers as another. Nothing was kept.',
        'integrity',
      );
    }
    const pinned = {
      id: account.accountId,
      name: me.value.accountName,
      publicKey: account.accountPublicKey,
    };
    yield* updateState(({ pendingPairing: _, ...current }) => ({ ...current, account: pinned }));
    yield* print({ status: 'loggedIn', serviceAccountId: key.credentialId, account: pinned });
  }, report),
).pipe(
  Command.withDescription(
    'Log in to the owner’s account from this computer: make a key here and ask the owner to approve it. Once approved, this login reads and writes every project of the account, including ones made later, and can make service accounts that hold part of its access',
  ),
);

export const logoutCommand = Command.make(
  'logout',
  {},
  Effect.fn('logout')(function* () {
    const store = yield* KeyStore;
    if (store.source === 'environment') return yield* store.remove;
    const kept = yield* store.read;
    // Revoke first: a key forgotten before the store hears of it would stay approved.
    const revoked = Option.isNone(kept)
      ? []
      : yield* Effect.gen(function* () {
          const { key, api } = yield* serviceAccountFromToken(kept.value);
          return yield* api.credentials.revoke({ params: { id: key.credentialId } }).pipe(
            Effect.map(({ revoked }) => revoked),
            // Never approved, already revoked or expired: nothing this key can still do.
            Effect.catchTag('UnauthorizedError', () => Effect.succeed([])),
          );
        });
    yield* store.remove;
    yield* removeState;
    yield* print({
      status: 'loggedOut',
      revoked,
      ...(revoked.length === 0
        ? {
            note: 'Nothing was revoked: no key was read here, or the store no longer accepts it (never approved, already revoked, or expired). If this login is still listed in the dashboard, revoke it there.',
          }
        : {}),
      next: 'Run `baymutt login` to log in again; it makes a new key.',
    });
  }, report),
).pipe(
  Command.withDescription(
    'Revoke this computer’s login, with every service account it made, and forget its key here. What it already read stays read. Refused when the key comes from BAYMUTT_KEY',
  ),
);
