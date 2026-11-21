// What approving each type of ask step writes. Each answer is checked against the step as it was
// read, then becomes one batch: a precondition, decided once in the statement that marks the step
// approved and before anything else is written, and the effects, each conditioned on that
// statement having taken. So a step happens whole or not at all, however many items it has.
import {
  type Actor,
  type ApproveStepPayload,
  type AskStep,
  InvalidRequestError,
} from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Effect from 'effect/Effect';
import type * as Statement from 'effect/sql/Statement';
import { encodeActor } from '../actors.ts';
import type { Audit } from '../audit.ts';
import type { secretWrites } from '../secret-writes.ts';
import type { ItemRow, LoadedAsk, StepRow } from './ask-rows.ts';
import { removeEnvironmentStatements, restoreEnvironmentStatements } from './environments.ts';
import {
  grantStatement,
  type Lookups,
  namesKeyWrapStatement,
  newEnvironmentStatements,
} from './rows.ts';
import { dayOf } from './service-accounts.ts';

/** How an approval's log entry names the key's end. */
export const endWords = (expiresAt: number | null | undefined) => {
  if (expiresAt === undefined) return 'same end';
  if (expiresAt === null) return 'no end';
  return `until ${dayOf(expiresAt)}`;
};

/** How a log entry names a step: its place and type, and the key it makes or changes. */
export const stepWords = (step: Pick<StepRow, 'position' | 'type' | 'keyName'>) =>
  `step ${step.position + 1}: ${step.type}${step.keyName === null ? '' : ` (${step.keyName})`}`;

type Approval = {
  /** Holds, inside the batch, when everything the step names is as approving it needs. */
  readonly precondition: Statement.Fragment;
  /** What approving does, each conditioned on `took`. */
  readonly effects: ReadonlyArray<Statement.Statement<unknown>>;
  /** What the step's own log entry says. */
  readonly detail: string;
};

type Context = {
  readonly loaded: LoadedAsk;
  readonly step: AskStep;
  readonly row: StepRow;
  readonly items: ReadonlyArray<ItemRow>;
  readonly actor: Actor;
  readonly accountId: string;
  readonly now: number;
  /** Holds once the statement that marks the step approved has taken. */
  readonly took: Statement.Fragment;
};

/** A refusal that names what does not match: nothing was written. */
const mismatch = (what: string) =>
  new InvalidRequestError({
    message: `The approval does not match the step: ${what}. Read the ask again and approve what the step names.`,
  });

/** Whether `ids` and `expected` hold the same ids, each once. */
const isSameSet = (ids: ReadonlyArray<string>, expected: ReadonlyArray<string>) => {
  const set = new Set(ids);
  return (
    set.size === ids.length && set.size === expected.length && set.isSubsetOf(new Set(expected))
  );
};

export const askApprovals = ({
  sql,
  audit,
  writes,
  lookups: { underLimit, nameTaken },
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
  readonly writes: ReturnType<typeof secretWrites>;
  readonly lookups: Lookups;
}) => {
  const json = (rows: ReadonlyArray<unknown>) => JSON.stringify(rows);

  /** No environment of `orgId` among `ids` (a JSON array) is missing from `state`. */
  const allEnvironments = (ids: ReadonlyArray<string>, orgId: string, isDeleted: boolean) =>
    sql`NOT EXISTS (SELECT 1 FROM json_each(${json(ids)}) j
      WHERE NOT EXISTS (SELECT 1 FROM environment e
        WHERE e.id = j.value AND e.org_id = ${orgId}
          AND (e.deleted_at IS NOT NULL) = ${isDeleted ? 1 : 0}))`;

  /** The key works: not revoked and, where `isEndChecked`, not ended. */
  const keyWorks = (keyId: string, now: number, isEndChecked: boolean) =>
    sql`EXISTS (SELECT 1 FROM credential WHERE id = ${keyId} AND revoked_at IS NULL
      AND (${isEndChecked ? 1 : 0} = 0 OR expires_at IS NULL OR expires_at > ${now}))`;

  /**
   * Why an environments step's `create` cannot be made now: an environment has its id, or its name
   * in the org, live or in the bin. Nothing when every one is free.
   */
  const createTaken = Effect.fnUntraced(function* ({
    loaded: { ask },
    items,
  }: Pick<Context, 'loaded' | 'items'>) {
    const creates = items.filter(item => item.op === 'create');
    const [taken] = yield* sql<{ readonly id: string; readonly name: string }>`
      SELECT json_extract(j.value, '$.id') AS id, json_extract(j.value, '$.name') AS name
      FROM json_each(${json(creates.map(item => ({ id: item.environmentId, name: item.itemEnvironmentName })))}) j
      WHERE EXISTS (SELECT 1 FROM environment e WHERE e.id = json_extract(j.value, '$.id')
        OR (e.org_id = ${ask.org.id} AND e.name = json_extract(j.value, '$.name')))
      LIMIT 1`.pipe(Effect.orDie);
    if (taken === undefined) return null;
    return yield* nameTaken({ ...taken, orgId: ask.org.id, orgSlug: ask.org.slug });
  });

  /** The read grants of an `access` or `change` step: one per environment, each at its current key. */
  const readGrantsMatch = Effect.fnUntraced(function* (
    reads: ReadonlyArray<ItemRow>,
    grants: Extract<ApproveStepPayload, { type: 'access' | 'change' }>['grants'],
  ) {
    if (
      !isSameSet(
        grants.map(grant => grant.environmentId),
        reads.map(item => item.environmentId),
      )
    ) {
      return yield* mismatch('one grant for each environment it reads');
    }
    for (const grant of grants) {
      const item = reads.find(read => read.environmentId === grant.environmentId);
      if (item?.keyVersion !== grant.keyVersion) {
        return yield* mismatch('each environment answered for its current key version');
      }
    }
  });

  const namesKeyWrapsMatch = (
    wraps: ReadonlyArray<{ readonly orgId: string }>,
    orgId: string,
    isNeeded: boolean,
  ) =>
    wraps.length === (isNeeded ? 1 : 0) && wraps.every(wrap => wrap.orgId === orgId)
      ? Effect.void
      : Effect.fail(mismatch('the names key of the ask’s org when it reads, and of no other'));

  const environments = Effect.fnUntraced(function* (
    context: Context,
    { creates }: Extract<ApproveStepPayload, { type: 'environments' }>,
  ) {
    const {
      loaded: { ask },
      items,
      actor,
      accountId,
      now,
      took,
    } = context;
    const asked = items.filter(item => item.op === 'create');
    if (
      !isSameSet(
        creates.map(create => create.environmentId),
        asked.map(item => item.environmentId),
      )
    ) {
      return yield* mismatch('one key pair for each environment it creates');
    }
    const taken = yield* createTaken(context);
    if (taken !== null) return yield* taken;
    const deletes = items.filter(item => item.op === 'delete').map(item => item.environmentId);
    const restores = items.filter(item => item.op === 'restore').map(item => item.environmentId);
    const adding = asked.length + restores.length;
    if (adding > 0) yield* underLimit(accountId, 'environments', adding);
    const orgId = ask.org.id;
    const named = asked.map(item => ({ id: item.environmentId, name: item.itemEnvironmentName }));
    const by = encodeActor(actor);
    const effects = yield* Effect.forEach(
      creates,
      Effect.fnUntraced(function* (create) {
        const item = asked.find(ask => ask.environmentId === create.environmentId);
        if (item?.itemEnvironmentName == null || item.itemEnvironmentSealedName === null) {
          return yield* Effect.die(`ask ${ask.id}: a create names no environment`);
        }
        const { made, statements } = newEnvironmentStatements(
          sql,
          {
            ...create,
            id: create.environmentId,
            orgId,
            name: item.itemEnvironmentName,
            sealedName: item.itemEnvironmentSealedName,
          },
          { accountId, createdBy: by, now, onlyIf: took },
        );
        return [
          ...statements,
          yield* audit.entry(
            { orgId, actor, action: 'environment.create', environmentId: create.environmentId },
            made,
          ),
        ];
      }),
      { concurrency: 1 },
    );
    return {
      // A name taken since the ask was read is the approval's error, not a block: see `failed`.
      precondition: sql`NOT EXISTS (SELECT 1 FROM json_each(${json(named)}) j
          JOIN environment e ON e.id = json_extract(j.value, '$.id')
            OR (e.org_id = ${orgId} AND e.name = json_extract(j.value, '$.name')))
        AND ${allEnvironments(deletes, orgId, false)}
        AND ${allEnvironments(restores, orgId, true)}`,
      effects: [
        ...effects.flat(),
        ...(yield* Effect.forEach(
          deletes,
          id =>
            removeEnvironmentStatements({ sql, audit }, { id, orgId, actor, now, onlyIf: took }),
          { concurrency: 1 },
        )).flat(),
        ...(yield* Effect.forEach(
          restores,
          id => restoreEnvironmentStatements({ sql, audit }, { id, orgId, actor, onlyIf: took }),
          { concurrency: 1 },
        )).flat(),
      ],
      detail: null,
    };
  });

  const access = Effect.fnUntraced(function* (
    { loaded: { ask }, row, items, actor, now, took }: Context,
    answer: Extract<ApproveStepPayload, { type: 'access' }>,
  ) {
    if (row.keyId === null || row.keyName === null) {
      return yield* Effect.die(`ask ${ask.id}: an access step has no key`);
    }
    const keyId = row.keyId;
    const keyName = row.keyName;
    // An end already past would make a key that never works.
    if (answer.expiresAt !== null && answer.expiresAt <= now) {
      return yield* mismatch('an end later than now');
    }
    yield* readGrantsMatch(items, answer.grants);
    yield* namesKeyWrapsMatch(answer.namesKeyWraps, ask.org.id, true);
    const orgId = ask.org.id;
    return {
      precondition: sql`${keyWorks(keyId, now, false)}
        AND ${allEnvironments(
          items.map(item => item.environmentId),
          orgId,
          false,
        )}`,
      effects: [
        ...answer.grants.map(grant =>
          grantStatement(sql, { ...grant, credentialId: keyId, now }, took),
        ),
        ...answer.namesKeyWraps.map(({ wrap }) =>
          namesKeyWrapStatement(sql, { orgId, readerId: keyId, wrap, now }, took),
        ),
        sql`UPDATE credential SET expires_at = ${answer.expiresAt} WHERE id = ${keyId} AND ${took}`,
        ...(yield* Effect.forEach(
          answer.grants,
          grant =>
            audit.entry(
              {
                orgId,
                actor,
                action: 'grant.set',
                environmentId: grant.environmentId,
                detail: `${keyName}: read`,
              },
              took,
            ),
          { concurrency: 1 },
        )),
      ],
      detail: endWords(answer.expiresAt),
    };
  });

  const change = Effect.fnUntraced(function* (
    { loaded: { ask }, step, row, items, actor, now, took }: Context,
    answer: Extract<ApproveStepPayload, { type: 'change' }>,
  ) {
    if (row.keyId === null || row.keyName === null || step.type !== 'change') {
      return yield* Effect.die(`ask ${ask.id}: a change step has no key`);
    }
    const keyId = row.keyId;
    const keyName = row.keyName;
    if (answer.expiresAt !== undefined && answer.expiresAt !== null && answer.expiresAt <= now) {
      return yield* mismatch('an end later than now');
    }
    const reads = items.filter(item => item.op === 'read');
    const giveBack = items.filter(item => item.op === 'give-back');
    yield* readGrantsMatch(reads, answer.grants);
    yield* namesKeyWrapsMatch(answer.namesKeyWraps, ask.org.id, reads.length > 0);
    const orgId = ask.org.id;
    return {
      precondition: sql`${keyWorks(keyId, now, true)}
        AND ${allEnvironments(
          reads.map(item => item.environmentId),
          orgId,
          false,
        )}`,
      effects: [
        ...answer.grants.map(grant =>
          grantStatement(sql, { ...grant, credentialId: keyId, now }, took),
        ),
        ...answer.namesKeyWraps.map(({ wrap }) =>
          namesKeyWrapStatement(sql, { orgId, readerId: keyId, wrap, now }, took),
        ),
        ...(yield* Effect.forEach(
          giveBack,
          Effect.fnUntraced(function* ({ environmentId }) {
            return [
              yield* audit.entry(
                { orgId, actor, action: 'grant.remove', environmentId, detail: keyName },
                sql`${took} AND EXISTS (SELECT 1 FROM environment_grant
                  WHERE environment_id = ${environmentId} AND credential_id = ${keyId})`,
              ),
              sql`DELETE FROM environment_grant
                  WHERE environment_id = ${environmentId} AND credential_id = ${keyId} AND ${took}`,
            ];
          }),
          { concurrency: 1 },
        )).flat(),
        ...(yield* Effect.forEach(
          reads,
          ({ environmentId }) =>
            audit.entry(
              {
                orgId,
                actor,
                action: 'grant.set',
                environmentId,
                detail: `${keyName}: read`,
              },
              took,
            ),
          { concurrency: 1 },
        )),
        ...(answer.expiresAt === undefined
          ? []
          : [
              sql`UPDATE credential SET expires_at = ${answer.expiresAt}
                  WHERE id = ${keyId} AND ${took}`,
            ]),
      ],
      detail: endWords(answer.expiresAt),
    };
  });

  const secrets = Effect.fnUntraced(function* (
    { loaded: { ask }, step, items, actor, took, now }: Context,
    { values }: Extract<ApproveStepPayload, { type: 'secrets' }>,
  ) {
    if (step.type !== 'secrets') return yield* Effect.die(`ask ${ask.id}: not a secrets step`);
    const orgId = ask.org.id;
    const sealing = items.filter(
      item => item.op === 'set' || item.op === 'paste' || item.op === 'generate',
    );
    if (
      !isSameSet(
        values.map(value => String(value.item)),
        sealing.map(item => String(item.position)),
      )
    ) {
      return yield* mismatch('one value for each secret it sets, pastes or generates');
    }
    const answered = values.map(value => {
      const item = sealing.find(ask => ask.position === value.item);
      const shown = step.items[value.item];
      if (item?.secretName == null || shown === undefined || !('nextVersion' in shown)) {
        throw new Error(`ask ${ask.id}: value ${value.item} has no item`);
      }
      return { value, item, shown, name: item.secretName };
    });
    // Each value was sealed for the slot the page showed: one written since moves the slot on.
    for (const { value, item, shown, name } of answered) {
      if (value.version !== shown.nextVersion || value.keyVersion !== shown.keyVersion) {
        return yield* yield* writes.conflict({ environmentId: item.environmentId, name });
      }
    }
    for (const { value, item } of answered) {
      yield* writes.underLimit(
        { environmentId: item.environmentId, version: value.version },
        answered.filter(
          other => other.item.environmentId === item.environmentId && other.value.version === 1,
        ).length,
      );
    }
    const moved = (op: ItemRow['op']) =>
      items
        .filter(item => item.op === op)
        .map(item => {
          if (item.secretName === null) throw new Error(`ask ${ask.id}: an item names no secret`);
          return { item, name: item.secretName };
        });
    const deletes = moved('delete');
    const restores = moved('restore');
    const rollbacks = moved('rollback');
    const slots = (
      rows: ReadonlyArray<{ item: ItemRow; name: string }>,
      version: (item: ItemRow) => number | null,
    ) => json(rows.map(({ item, name }) => ({ e: item.environmentId, n: name, v: version(item) })));
    const live = sql`EXISTS (SELECT 1 FROM environment e
      WHERE e.id = json_extract(j.value, '$.e') AND e.org_id = ${orgId} AND e.deleted_at IS NULL)`;
    const secretIs = (condition: Statement.Fragment) =>
      sql`EXISTS (SELECT 1 FROM secret s
        WHERE s.environment_id = json_extract(j.value, '$.e') AND s.name = json_extract(j.value, '$.n')
          AND ${condition})`;
    const precondition = sql`NOT EXISTS (SELECT 1 FROM json_each(${json(
      answered.map(({ value, item, name }) => ({
        e: item.environmentId,
        n: name,
        v: value.version,
        k: value.keyVersion,
      })),
    )}) j WHERE NOT (EXISTS (SELECT 1 FROM environment e
          WHERE e.id = json_extract(j.value, '$.e') AND e.org_id = ${orgId} AND e.deleted_at IS NULL
            AND e.key_version = json_extract(j.value, '$.k'))
        AND COALESCE((SELECT s.latest_version FROM secret s
          WHERE s.environment_id = json_extract(j.value, '$.e') AND s.name = json_extract(j.value, '$.n')), 0)
          = json_extract(j.value, '$.v') - 1))
      AND NOT EXISTS (SELECT 1 FROM json_each(${slots(deletes, () => null)}) j
        WHERE NOT (${live} AND ${secretIs(sql`s.current_version IS NOT NULL`)}))
      AND NOT EXISTS (SELECT 1 FROM json_each(${slots(restores, item => item.latestVersion)}) j
        WHERE NOT (${live} AND ${secretIs(
          sql`s.current_version IS NULL AND s.latest_version = json_extract(j.value, '$.v')`,
        )}))
      AND NOT EXISTS (SELECT 1 FROM json_each(${slots(rollbacks, item => item.version)}) j
        WHERE NOT (${live} AND EXISTS (SELECT 1 FROM secret_version v
          WHERE v.environment_id = json_extract(j.value, '$.e')
            AND v.name = json_extract(j.value, '$.n') AND v.version = json_extract(j.value, '$.v'))))`;

    const point = (
      { item, name }: { item: ItemRow; name: string },
      move: Pick<
        Parameters<typeof writes.pointStatements>[1],
        'to' | 'fromBin' | 'action' | 'detail'
      >,
    ) =>
      writes.pointStatements(
        { environmentId: item.environmentId, name },
        { ...move, orgId, actor, now, onlyIf: took },
      );
    return {
      precondition,
      effects: [
        ...(yield* Effect.forEach(
          answered,
          ({ value, item, name }) =>
            writes
              .writeStatements(
                {
                  environmentId: item.environmentId,
                  name,
                  version: value.version,
                  keyVersion: value.keyVersion,
                  ciphertext: value.ciphertext,
                  // A name that exists keeps its own.
                  sealedName:
                    value.version === 1 ? (item.itemSecretSealedName ?? undefined) : undefined,
                },
                { orgId, actor, action: 'secret.write', alsoIf: took },
              )
              .pipe(Effect.map(({ statements }) => statements)),
          { concurrency: 1 },
        )).flat(),
        ...(yield* Effect.forEach(
          deletes,
          slot => point(slot, { to: null, action: 'secret.delete', detail: null }),
          { concurrency: 1 },
        )).flat(),
        ...(yield* Effect.forEach(
          restores,
          slot =>
            point(slot, {
              to: slot.item.latestVersion,
              fromBin: true,
              action: 'secret.rollback',
              detail: 'from the bin',
            }),
          { concurrency: 1 },
        )).flat(),
        ...(yield* Effect.forEach(
          rollbacks,
          slot =>
            point(slot, {
              to: slot.item.version,
              action: 'secret.rollback',
              detail: slot.item.currentVersion === null ? 'from the bin' : null,
            }),
          { concurrency: 1 },
        )).flat(),
      ],
      detail: null,
    };
  });

  /** What approving a step with `answer` writes, once the answer matches what the step names. */
  const approval = Effect.fnUntraced(function* (context: Context, answer: ApproveStepPayload) {
    const { detail, ...approved } = yield* (() => {
      switch (answer.type) {
        case 'environments':
          return environments(context, answer);
        case 'access':
          return access(context, answer);
        case 'change':
          return change(context, answer);
        case 'secrets':
          return secrets(context, answer);
      }
    })();
    return {
      ...approved,
      detail: detail === null ? stepWords(context.row) : `${stepWords(context.row)}, ${detail}`,
    } satisfies Approval;
  });

  return { approval, createTaken };
};
