// Keys: listing and revoking them, and the activity. A key other than a CLI login comes from a
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

/**
 * Which of the three a key is: a CLI login (`baymutt auth login`), a service account (made for
 * another system: its ask gave a command to pipe it into) or an agent key (an agent's own, kept
 * in a file). The store says which in `intent`; a key it has none for is told by its end.
 */
export const kindOf = ({
  parentId,
  intent,
  expiresAt,
}: Pick<Listed, 'parentId' | 'intent' | 'expiresAt'>) => {
  if (parentId === null) return 'cli-login';
  if (intent === 'agent') return 'agent-key';
  if (intent === 'service-account') return 'service-account';
  return expiresAt === null ? 'service-account' : 'agent-key';
};

/** A key as listed: which kind it is, the slug of its org, and the environments it holds named as written. */
export const namedKey = (namesKeys: NamesKeys, { grants, org, ...key }: Listed) =>
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
    named => ({ kind: kindOf(key), ...key, org: org?.slug ?? null, grants: named }),
  );

const listCommand = Command.make(
  'list',
  {},
  Effect.fn('key.list')(function* () {
    const { api } = yield* ServiceAccount;
    const [{ credentials }, { namesKeys }] = yield* Effect.all(
      [api.credentials.list(), listEnvironments()],
      { concurrency: 2 },
    );
    yield* print({
      keys: yield* Effect.forEach(credentials, credential => namedKey(namesKeys, credential)),
    });
  }, report),
).pipe(
  Command.withDescription(
    'This key, and the keys it asked for, with what each holds. `kind` says which each is: `cli-login` (made by `baymutt auth login`, lists names and holds no environment), `agent-key` (asked for with `baymutt ask access` and kept in a file, for an agent’s own work) or `service-account` (asked for with a command after --, for another system such as CI). `org` is the slug of the one org a key belongs to, whose environments alone it can hold; null for a CLI login, which is the account’s',
  ),
);

const revokeCommand = Command.make(
  'revoke',
  {
    id: Argument.String('id').pipe(
      Argument.withDescription(
        'The id of a key this CLI login asked for, or of this key itself (see `baymutt key list`). To revoke this computer’s own CLI login and forget its key, use `baymutt auth logout`',
      ),
    ),
  },
  Effect.fn('key.revoke')(function* ({ id }) {
    const { api } = yield* ServiceAccount;
    yield* print(yield* api.credentials.revoke({ params: { id } }));
  }, report),
).pipe(
  Command.withDescription(
    'Revoke a key this CLI login asked for, or this key itself by its id, with every key it asked for. What it already read stays read. To give back only some of what a key holds, use `baymutt ask change <id> --give-back <org>/<name>`',
  ),
);

export const keyCommand = Command.make('key').pipe(
  Command.withDescription(
    'List and revoke keys. A new one comes from `baymutt ask access` once the owner approves it; `baymutt ask change` changes what one holds',
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
    'What this key did, newest first. The owner reads all of an org’s activity in the dashboard',
  ),
);

export const activityCommand = Command.make('activity').pipe(
  Command.withDescription('The log of what this key did'),
  Command.withSubcommands([activityListCommand]),
  Command.provide(ServiceAccount.layer),
);
