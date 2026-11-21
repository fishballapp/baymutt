// The statements that write a secret or move its current version, and the checks before them:
// `Secrets` runs them for the owner's own write; an approved ask step runs several in one batch. Each is the caller's to put in a batch, with its log entry.
import { type Actor, LIMITS, LimitReachedError, VersionConflictError } from '@baymutt/api';
import type * as D1Client from '@effect/sql-d1/D1Client';
import * as Clock from 'effect/Clock';
import * as Effect from 'effect/Effect';
import type * as Statement from 'effect/sql/Statement';
import { encodeActor } from './actors.ts';
import type { Audit } from './audit.ts';
import { BIN_MS } from './bin.ts';

export type Slot = { readonly environmentId: string; readonly name: string };

export type SealedValue = {
  readonly version: number;
  readonly keyVersion: number;
  readonly ciphertext: string;
};

export type Write = Slot &
  SealedValue & {
    /** Needed for a new name, which is stored only in a sealed org; ignored for one that exists. */
    readonly sealedName?: string | undefined;
  };

export const secretWrites = ({
  sql,
  audit,
}: {
  readonly sql: D1Client.D1Client;
  readonly audit: Audit['Service'];
}) => {
  /**
   * The three statements of a write: the secret's row moves to `version` only from the one
   * below it and only under the environment's current key, the version row is added only if that
   * took, and so is the log entry. `alsoIf` is one more condition on the first.
   */
  const writeStatements = Effect.fnUntraced(function* (
    { environmentId, name, version, keyVersion, ciphertext, sealedName }: Write,
    {
      orgId,
      actor,
      action,
      alsoIf,
    }: {
      readonly orgId: string;
      readonly actor: Actor;
      readonly action: 'secret.write';
      readonly alsoIf?: Statement.Fragment;
    },
  ) {
    const now = yield* Clock.currentTimeMillis;
    const by = encodeActor(actor);
    const writeId = crypto.randomUUID();
    const took = sql`EXISTS (SELECT 1 FROM secret
      WHERE environment_id = ${environmentId} AND name = ${name} AND write_id = ${writeId})`;
    const statements = [
      // A new name is stored only with its sealed name; one that exists keeps its own.
      sql`INSERT INTO secret
            (environment_id, name, sealed_name, current_version, latest_version, updated_at,
             updated_by, write_id)
          SELECT ${environmentId}, ${name}, ${sealedName ?? null}, ${version}, ${version},
            ${now}, ${by}, ${writeId}
          WHERE EXISTS (SELECT 1 FROM environment
                        WHERE id = ${environmentId} AND key_version = ${keyVersion}
                          AND deleted_at IS NULL)
            AND ((${version} = 1 AND ${sealedName ?? null} IS NOT NULL)
                 OR EXISTS (SELECT 1 FROM secret
                            WHERE environment_id = ${environmentId} AND name = ${name}))
            AND ${alsoIf ?? sql`1 = 1`}
          ON CONFLICT (environment_id, name) DO UPDATE
            SET current_version = excluded.current_version,
                latest_version = excluded.latest_version,
                updated_at = excluded.updated_at, updated_by = excluded.updated_by,
                write_id = excluded.write_id, purge_at = NULL
            WHERE secret.latest_version = excluded.latest_version - 1
          RETURNING latest_version`,
      sql`INSERT INTO secret_version
            (environment_id, name, version, key_version, ciphertext, created_by, created_at)
          SELECT ${environmentId}, ${name}, ${version}, ${keyVersion}, ${ciphertext}, ${by},
            ${now}
          WHERE ${took}`,
      yield* audit.entry({ orgId, actor, action, environmentId, secretName: name, version }, took),
    ] as const;
    return { statements, took };
  });

  /** Counted before the write: a cap on growth, which two writers at once can overshoot by one. */
  const underLimit = Effect.fnUntraced(function* (
    { environmentId, version }: Pick<Write, 'environmentId' | 'version'>,
    /** How many new names this one write adds to the environment, when it adds several. */
    adding = 1,
  ) {
    if (version > LIMITS.versionsPerSecret) {
      return yield* new LimitReachedError({
        limit: LIMITS.versionsPerSecret,
        message: `A secret keeps up to ${LIMITS.versionsPerSecret} versions while baymutt is in beta.`,
      });
    }
    if (version !== 1) return;
    const [row] = yield* sql`SELECT COUNT(*) AS held FROM secret
      WHERE environment_id = ${environmentId}`.pipe(Effect.orDie);
    if (Number(row?.held ?? 0) + adding > LIMITS.secretsPerEnvironment) {
      return yield* new LimitReachedError({
        limit: LIMITS.secretsPerEnvironment,
        message: `An environment holds up to ${LIMITS.secretsPerEnvironment} secrets while baymutt is in beta.`,
      });
    }
  });

  const conflict = Effect.fnUntraced(function* ({ environmentId, name }: Slot) {
    const [found] = yield* sql`SELECT
        (SELECT latest_version FROM secret WHERE environment_id = ${environmentId} AND name = ${name})
          AS latest_version,
        (SELECT key_version FROM environment WHERE id = ${environmentId}) AS key_version`.pipe(
      Effect.orDie,
    );
    const latestVersion = Number(found?.latestVersion ?? 0);
    const keyVersion = Number(found?.keyVersion ?? 0);
    return new VersionConflictError({
      latestVersion,
      keyVersion,
      message: `This secret is at version ${latestVersion} under environment key ${keyVersion}. Seal the value again for version ${latestVersion + 1} and that key, then write it.`,
    });
  });

  /**
   * Moves the current-version pointer to `to` (null: to the bin) and logs it, when the secret
   * exists, and only if `onlyIf`. The first statement answers the name when it moved.
   */
  const pointStatements = Effect.fnUntraced(function* (
    { environmentId, name }: Slot,
    {
      to,
      fromBin = false,
      orgId,
      actor,
      action,
      detail,
      now,
      onlyIf = sql`1 = 1`,
    }: {
      readonly to: number | null;
      /** A restore from the bin: nothing moves when the secret has left it since. */
      readonly fromBin?: boolean;
      readonly orgId: string;
      readonly actor: Actor;
      readonly action: 'secret.delete' | 'secret.rollback';
      readonly detail: string | null;
      readonly now: number;
      readonly onlyIf?: Statement.Fragment;
    },
  ) {
    const writeId = crypto.randomUUID();
    return [
      sql`UPDATE secret
          SET current_version = ${to}, updated_at = ${now}, updated_by = ${encodeActor(actor)},
              write_id = ${writeId}, purge_at = ${to === null ? now + BIN_MS : null}
          WHERE environment_id = ${environmentId} AND name = ${name}
            AND (${to} IS NOT NULL OR current_version IS NOT NULL)
            AND (${fromBin ? 1 : 0} = 0 OR current_version IS NULL)
            AND (${to} IS NULL OR EXISTS (SELECT 1 FROM secret_version
                                         WHERE environment_id = ${environmentId} AND name = ${name}
                                           AND version = ${to}))
            AND ${onlyIf}
          RETURNING name`,
      yield* audit.entry(
        { orgId, actor, action, environmentId, secretName: name, version: to, detail },
        sql`EXISTS (SELECT 1 FROM secret WHERE environment_id = ${environmentId} AND name = ${name}
                     AND write_id = ${writeId})`,
      ),
    ] as const;
  });

  return { writeStatements, pointStatements, underLimit, conflict };
};
