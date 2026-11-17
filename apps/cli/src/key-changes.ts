// A key change from the terminal's side: `baymutt ask change` asks to add to, give back from, or
// re-end a key this login asked for, and the key keeps its file. Approved, the key file holds the
// new set; rejected, expired or gone, it holds what it held. Either way it stays where it is.
// What was asked is kept in an owner-only file beside the keys (`<change id>.change`), and `ask
// wait` checks the key against that record, never against what the store says the change was.
import type { KeyChange } from '@baymutt/api';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import * as Schema from 'effect/Schema';
import { listEnvironments } from './environments.ts';
import { answerFor, usage } from './errors.ts';
import type { Outcome } from './outcome.ts';
import { checkHolds, isId, keyFileOf } from './requests.ts';
import { ServiceAccount } from './service-account.ts';
import { Settings } from './settings.ts';

const POLL_EVERY = Duration.seconds(2);

/** What a change asked, as typed on this computer: the key it is for and what it adds and gives back. */
const AskedSchema = Schema.Struct({
  keyId: Schema.String,
  add: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      canRead: Schema.Boolean,
      canWrite: Schema.Boolean,
    }),
  ),
  giveBack: Schema.Array(Schema.String),
  asksNewEnd: Schema.Boolean,
});
type Asked = typeof AskedSchema.Type;
const AskedFileSchema = Schema.fromJsonString(AskedSchema);

/** Where what change `id` asked is kept: only ever for an id, as a key file is. */
const recordFileOf = Effect.fn('keyChanges.recordFile')(function* (id: string) {
  if (!isId(id)) return yield* usage(`${id} is not the id of a key change.`);
  return `${yield* keyFileOf(id)}.change`;
});

/** Keeps what a change asks, before it is sent: `ask wait` checks the key against it. */
export const keepAsked = Effect.fn('keyChanges.keepAsked')(function* (id: string, asked: Asked) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* Schema.encodeEffect(AskedFileSchema)(asked).pipe(Effect.orDie);
  yield* fs
    .writeFileString(yield* recordFileOf(id), `${text}\n`, { mode: 0o600 })
    .pipe(Effect.orDie);
});

/** Forgets what a change asked, once it is answered or never reached the store. */
export const forgetAsked = Effect.fn('keyChanges.forgetAsked')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs.remove(yield* recordFileOf(id)).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.void),
    Effect.orDie,
  );
});

/** What change `id` asked, as kept here; None when it was asked elsewhere or its record is gone. */
const readAsked = Effect.fn('keyChanges.readAsked')(function* (id: string) {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* recordFileOf(id);
  const text = yield* fs.readFileString(file).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie,
  );
  if (Option.isNone(text)) return Option.none<Asked>();
  const asked = yield* Schema.decodeEffect(AskedFileSchema)(text.value).pipe(
    Effect.catchTag('SchemaError', () =>
      Effect.fail(usage(`This file is not a key change baymutt kept: ${file}. Fix or delete it.`)),
    ),
  );
  return Option.some(asked);
});

/** Where the owner answers a key change: its page under the org its key belongs to. */
export const keyChangeUrl = Effect.fn('keyChanges.url')(function* ({
  id,
  org,
}: Pick<KeyChange, 'id' | 'org'>) {
  const { origin } = yield* Settings;
  return `${origin}/orgs/${org.slug}/ask/change/${id}`;
});

/** The key file of `keyId`, if this computer holds it: what decides whether a change is checked with the key. */
const keyFileHere = Effect.fn('keyChanges.keyFileHere')(function* (keyId: string) {
  const fs = yield* FileSystem.FileSystem;
  const keyFile = yield* keyFileOf(keyId);
  const token = yield* fs.readFileString(keyFile).pipe(
    Effect.asSome,
    Effect.catchReason('PlatformError', 'NotFound', () => Effect.succeedNone),
    Effect.orDie,
  );
  return Option.map(token, text => ({ keyFile, token: text.trim() }));
});

/** What the key `token` holds now, each environment by its address, as the key itself lists it. */
export const describeHoldings = Effect.fn('keyChanges.describeHoldings')(function* (
  listed: ReadonlyArray<{
    readonly id: string;
    readonly canRead: boolean;
    readonly canWrite: boolean;
  }>,
) {
  const { environments } = yield* listEnvironments();
  return listed
    .filter(({ canRead, canWrite }) => canRead || canWrite)
    .map(({ id, canRead, canWrite }) => ({
      environment: environments.find(environment => environment.id === id)?.address ?? id,
      canRead,
      canWrite,
    }));
});

/**
 * What a change that took effect prints, once the key is checked against what was asked here: it
 * is the key asked for, every environment asked is held with at least the access asked (an added
 * read opened with the key itself), and every environment given back is no longer held. What the
 * store says the change was is not used.
 */
const changed = Effect.fn('keyChanges.changed')(function* (id: string, change: KeyChange) {
  const kept = yield* readAsked(id);
  if (Option.isNone(kept)) {
    return yield* usage(
      `Key change ${change.id} was not asked on this computer, or what it asked is no longer kept here, so what the key holds now cannot be checked against it. See the key with \`baymutt key list\`; ask again from the computer that holds its key file.`,
      'notFound',
    );
  }
  const asked = kept.value;
  const integrity = (what: string) =>
    usage(
      `The store says key change ${change.id} ${change.status === 'applied' ? 'took effect' : 'was approved'}, but ${what}. Key ${asked.keyId} may hold what it held before; nothing was taken on the store's word.`,
      'integrity',
    );
  if (change.key.id !== asked.keyId) {
    return yield* integrity(`it names key ${change.key.id}, not the key it was asked for`);
  }
  if (change.status === 'applied' && (asked.add.length > 0 || asked.asksNewEnd)) {
    return yield* integrity('only giving back takes effect without the owner');
  }
  // What this computer holds decides how far it is checked, never what the store calls the key.
  const here = yield* keyFileHere(asked.keyId);
  if (Option.isNone(here)) return yield* changedElsewhere(change, asked, integrity);
  const { keyFile, token } = here.value;
  const listed = yield* checkHolds(
    asked.add,
    token,
    integrity(`key ${asked.keyId} does not hold what it added with the owner's proof`),
    { unwrapsReads: true },
  );
  const stillHeld = asked.giveBack.filter(environmentId =>
    listed.some(({ id, canRead, canWrite }) => id === environmentId && (canRead || canWrite)),
  );
  if (stillHeld.length > 0) {
    return yield* integrity(`key ${asked.keyId} still holds what it gave back`);
  }
  yield* forgetAsked(change.id);
  return {
    id: change.id,
    status: change.status,
    key: asked.keyId,
    keyFile,
    expiresAt: change.key.expiresAt,
    environments: yield* describeHoldings(listed),
  };
});

/**
 * A change to a key whose file is not on this computer, such as a service account's, piped into a
 * command. The owner's proof of each environment is a box only that key (or the account's) opens,
 * so only the store's own account is checked, against what was asked here: the same key, listed
 * holding at least what was added and no longer what was given back. Whether it really reads what
 * it gained is not checked, and the result says so: its next load is what proves it.
 */
const changedElsewhere = Effect.fn('keyChanges.changedElsewhere')(function* (
  change: KeyChange,
  asked: Asked,
  integrity: (what: string) => ReturnType<typeof usage>,
) {
  const { api } = yield* ServiceAccount;
  const { credentials } = yield* api.credentials.list();
  const key = credentials.find(({ id }) => id === asked.keyId);
  if (key === undefined) return yield* integrity(`key ${asked.keyId} is not listed`);
  const isShort = asked.add.some(item => {
    const grant = key.grants.find(({ environmentId }) => environmentId === item.environmentId);
    return (
      grant === undefined || (item.canRead && !grant.canRead) || (item.canWrite && !grant.canWrite)
    );
  });
  if (isShort) {
    return yield* integrity(`the store does not list key ${asked.keyId} holding what it added`);
  }
  if (key.grants.some(({ environmentId }) => asked.giveBack.includes(environmentId))) {
    return yield* integrity(`the store lists key ${asked.keyId} still holding what it gave back`);
  }
  yield* forgetAsked(change.id);
  return {
    id: change.id,
    status: change.status,
    key: asked.keyId,
    expiresAt: key.expiresAt,
    environments: yield* describeHoldings(
      key.grants.map(({ environmentId, canRead, canWrite }) => ({
        id: environmentId,
        canRead,
        canWrite,
      })),
    ),
    unchecked:
      'This is the store’s account of what the key holds, checked against what was asked here and nothing more. No file of this key is on this computer, so the owner’s proof of each environment and any read it gained were not checked.',
    next: 'The key’s next load or write, with the key itself, is what proves a read or a write it gained.',
  };
});

/**
 * Waits up to `timeout` seconds for the owner's answer to a key change this login asked for. Approved,
 * it checks that the key holds what was added, and says what it holds now. Rejected, expired or
 * gone, the key holds what it held, and its file stays.
 */
export const settleKeyChange = Effect.fn('keyChanges.settle')(function* (
  id: string,
  change: KeyChange,
  timeout: number,
) {
  const { api } = yield* ServiceAccount;
  // None: the store no longer has it.
  const latest = api.keyChanges.get({ params: { id } }).pipe(
    // Refused unless it names `id`: the record is read and removed by the id asked for.
    answerFor(id),
    Effect.asSome,
    Effect.catchTag('NotFoundError', () => Effect.succeedNone),
  );
  const answered =
    change.status === 'pending'
      ? yield* latest.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(POLL_EVERY),
            until: current => Option.isNone(current) || current.value.status !== 'pending',
          }),
          Effect.timeoutOption(Duration.seconds(timeout)),
        )
      : Option.some(Option.some(change));

  if (Option.isNone(answered)) {
    return {
      kind: 'unanswered',
      result: {
        id: id,
        status: 'pending',
        url: yield* keyChangeUrl(change),
        next: `Run \`baymutt ask wait ${id}\` to keep waiting. Key ${change.key.id} keeps working with what it holds meanwhile.`,
      },
      failure: usage(
        `The owner has not answered key change ${id} yet. It waits an hour from when it was asked: run \`baymutt ask wait ${id}\` to keep waiting.`,
        'differs',
      ),
    } satisfies Outcome;
  }
  const current = answered.value;
  if (
    Option.isSome(current) &&
    (current.value.status === 'approved' || current.value.status === 'applied')
  ) {
    return { kind: 'granted', result: yield* changed(id, current.value) } satisfies Outcome;
  }
  const status = Option.isSome(current) ? current.value.status : 'gone';
  yield* forgetAsked(id);
  const what = {
    rejected: `The owner rejected key change ${id}.`,
    expired: `Nobody answered key change ${id} within an hour, so it expired.`,
    gone: `Key change ${id} is gone: the store no longer has it.`,
  }[status === 'rejected' || status === 'expired' ? status : 'gone'];
  return {
    kind: 'refused',
    status,
    failure: usage(
      `${what} Key ${change.key.id} holds what it held before, and keeps working until it ends.`,
      'noAccess',
    ),
  } satisfies Outcome;
});
