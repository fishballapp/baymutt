// `baymutt pair`: makes this machine's key and asks the owner to approve it. Run it again to
// finish: it picks up where it left off.
import { PairingRequestSchema } from '@baymutt/api';
import { generateMachineToken, openWelcome, pairingCode, randomToken } from '@baymutt/keys';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { crypto_, report, usage } from '../errors.ts';
import { KeyStore } from '../key-store.ts';
import { machineFromToken } from '../machine.ts';
import { print, say } from '../output.ts';
import { readState, Settings, updateState } from '../settings.ts';

const PairingFragmentSchema = Schema.fromJsonString(PairingRequestSchema);

const POLL_EVERY = Duration.seconds(2);

/** The machine's key: the one already kept when a pairing is under way, or a new one. */
const machineToken = Effect.gen(function* () {
  const store = yield* KeyStore;
  const kept = yield* store.read;
  if (Option.isSome(kept)) return kept.value;
  const token = Redacted.make(generateMachineToken());
  yield* store.write(token);
  return token;
});

export const pairCommand = Command.make(
  'pair',
  {
    name: Flag.String('name').pipe(
      Flag.withDescription('What the owner will see this machine as, such as "Jason’s MacBook"'),
      Flag.optional,
    ),
    wait: Flag.Int('wait').pipe(
      Flag.withDescription(
        'Seconds to wait for the owner’s approval before returning (0 to return at once)',
      ),
      Flag.withDefault(300),
    ),
  },
  Effect.fn('pair')(function* ({ name, wait }) {
    const { origin } = yield* Settings;
    const { key, api } = yield* machineFromToken(yield* machineToken);
    const state = yield* readState;

    if (state.account !== undefined) {
      return yield* print({
        status: 'paired',
        machineId: key.credentialId,
        account: state.account,
      });
    }

    const pending = state.pendingPairing ?? {
      pairingSecret: randomToken(),
      name: Option.getOrElse(name, () => `machine ${key.credentialId.slice(0, 8)}`),
    };
    yield* updateState(current => ({ ...current, pendingPairing: pending }));

    const fragment = yield* Schema.encodeEffect(PairingFragmentSchema)({
      id: key.credentialId,
      name: pending.name,
      publicKey: key.publicKey,
      bearerHash: key.bearerHash,
      pairingSecret: pending.pairingSecret,
    }).pipe(Effect.orDie);
    const url = `${origin}/pair#${encodeURIComponent(fragment)}`;
    const code = yield* crypto_(() => pairingCode(key.publicKey));

    // Paired once the store recognises the bearer; until then it answers 401.
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
        machineId: key.credentialId,
        code,
        url,
        next: 'Run `baymutt pair` again once the owner has approved it.',
      });
    }

    const welcome = me.value.credential?.welcome;
    if (welcome === null || welcome === undefined) {
      return yield* usage(
        'The store knows this machine key but has no answer from a browser that paired it. Use a machine key made by `baymutt pair`.',
        'integrity',
      );
    }
    // Sealed by the owner's browser under a secret the store never saw: this is where the machine
    // learns which account key to trust.
    const account = yield* crypto_(() =>
      openWelcome(
        {
          pairingSecret: pending.pairingSecret,
          credentialId: key.credentialId,
          machinePublicKey: key.publicKey,
        },
        welcome,
      ),
    );
    if (account.accountId !== me.value.accountId) {
      return yield* usage(
        'The browser paired this machine with one account and the store answers as another. Nothing was kept.',
        'integrity',
      );
    }
    const pinned = {
      id: account.accountId,
      name: me.value.accountName,
      publicKey: account.accountPublicKey,
    };
    yield* updateState(({ pendingPairing: _, ...current }) => ({ ...current, account: pinned }));
    yield* print({ status: 'paired', machineId: key.credentialId, account: pinned });
  }, report),
).pipe(
  Command.withDescription(
    'Pair this machine with the owner’s account. It starts with no access: ask for some with `baymutt access request`.',
  ),
);
