// Service accounts: listing and revoking them, and the activity. A service account comes from a
// request (`baymutt ask access`) the owner approved.
import type { ActivityEvent, ServiceAccount as Listed } from '@baymutt/api';
import * as Argument from 'effect/cli/Argument';
import * as Command from 'effect/cli/Command';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { listEnvironments, resolveIn } from '../environments.ts';
import { report } from '../errors.ts';
import { type NamesKeys, openStoredName } from '../names.ts';
import { print } from '../output.ts';
import { ServiceAccount } from '../service-account.ts';

/** A credential as listed, the environments it holds named as written. */
export const namedCredential = (namesKeys: NamesKeys, { grants, ...credential }: Listed) =>
  Effect.map(
    Effect.forEach(
      grants,
      ({ environmentName, environmentSealedName, ...grant }) =>
        Effect.map(
          openStoredName(namesKeys.get(grant.orgId) ?? null, {
            scopeId: grant.orgId,
            stored: { name: environmentName, sealedName: environmentSealedName },
          }),
          name => ({ ...grant, environmentName: name }),
        ),
      { concurrency: 'unbounded' },
    ),
    named => ({ ...credential, grants: named }),
  );

const listCommand = Command.make(
  'list',
  {},
  Effect.fn('service-account.list')(function* () {
    const { api } = yield* ServiceAccount;
    const [{ credentials }, { namesKeys }] = yield* Effect.all(
      [api.credentials.list(), listEnvironments()],
      { concurrency: 2 },
    );
    yield* print({
      credentials: yield* Effect.forEach(credentials, credential =>
        namedCredential(namesKeys, credential),
      ),
    });
  }, report),
).pipe(
  Command.withDescription(
    'This CLI login or service account, and the service accounts its requests made, with what each holds',
  ),
);

const revokeCommand = Command.make(
  'revoke',
  {
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'The id of a service account this CLI login asked for, or of this one itself (see `baymutt service-account list`). To revoke this computer’s own CLI login and forget its key, use `baymutt auth logout`',
      ),
    ),
  },
  Effect.fn('service-account.revoke')(function* ({ id }) {
    const { api } = yield* ServiceAccount;
    yield* print(yield* api.credentials.revoke({ params: { id } }));
  }, report),
).pipe(
  Command.withDescription(
    'Revoke a service account this CLI login asked for, or this one itself by its id, with every service account it asked for. What it already read stays read',
  ),
);

export const serviceAccountCommand = Command.make('service-account').pipe(
  Command.withDescription(
    'List and revoke service accounts. A new one comes from `baymutt ask access`, once the owner approves it',
  ),
  Command.withSubcommands([listCommand, revokeCommand]),
  Command.provide(ServiceAccount.layer),
);

/** An activity entry with the names it mentions as written. */
const namedEvent = Effect.fnUntraced(function* (
  namesKeys: NamesKeys,
  { environmentName, environmentSealedName, secretName, secretSealedName, ...event }: ActivityEvent,
) {
  const namesKey = event.orgId === null ? null : (namesKeys.get(event.orgId) ?? null);
  const open = (scopeId: string | null, name: string | null, sealedName: string | null) =>
    scopeId === null || name === null
      ? Effect.succeed(name)
      : openStoredName(namesKey, { scopeId, stored: { name, sealedName } });
  return {
    ...event,
    environmentName: yield* open(event.orgId, environmentName, environmentSealedName),
    secretName: yield* open(event.environmentId, secretName, secretSealedName),
  };
});

const activityListCommand = Command.make(
  'list',
  {
    environment: Flag.String('environment').pipe(
      Flag.withDescription('Only this environment’s entries: <org>/<name>'),
      Flag.optional,
    ),
    limit: Flag.Int('limit').pipe(
      Flag.withDescription('How many entries (1 to 200)'),
      Flag.withDefault(50),
    ),
    before: Flag.String('before').pipe(
      Flag.withDescription(
        'An entry id: answer the entries before it (`nextBefore` of the last page)',
      ),
      Flag.optional,
    ),
  },
  Effect.fn('activity.list')(function* ({ environment, limit, before }) {
    const { api } = yield* ServiceAccount;
    const { environments, namesKeys } = yield* listEnvironments();
    const environmentId = Option.isSome(environment)
      ? (yield* resolveIn(environments, environment.value)).id
      : undefined;
    const { events, ...page } = yield* api.activity.list({
      query: {
        limit,
        ...(environmentId === undefined ? {} : { environmentId }),
        ...(Option.isSome(before) ? { before: before.value } : {}),
      },
    });
    yield* print({
      ...page,
      events: yield* Effect.forEach(events, event => namedEvent(namesKeys, event), {
        concurrency: 'unbounded',
      }),
    });
  }, report),
).pipe(
  Command.withDescription(
    'What this CLI login or service account did, newest first. The owner reads all of an org’s activity in the dashboard',
  ),
);

export const activityCommand = Command.make('activity').pipe(
  Command.withDescription('The log of what this key did'),
  Command.withSubcommands([activityListCommand]),
  Command.provide(ServiceAccount.layer),
);
