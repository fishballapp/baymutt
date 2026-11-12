// Writing a value: sealed here to the project's public key, for the one slot it will fill.
import { MAX_VALUE_BYTES, type Project } from '@baymutt/api';
import { sealValue } from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import { crypto_, usage } from './errors.ts';
import { trustedKey } from './projects.ts';
import { ServiceAccount } from './service-account.ts';

export const writeValue = Effect.fn('secrets.write')(function* ({
  project,
  name,
  value,
}: {
  readonly project: Project;
  readonly name: string;
  readonly value: string;
}) {
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_VALUE_BYTES) {
    return yield* usage(`${name} is ${bytes} bytes; a value may be ${MAX_VALUE_BYTES}.`);
  }
  const { api } = yield* ServiceAccount;
  const { publicKey: projectPublicKey, binding } = yield* trustedKey(project);
  const { secrets } = yield* api.secrets.list({ params: { projectId: project.id } });
  const latest = secrets.find(secret => secret.name === name)?.latestVersion ?? 0;

  const writeAs = Effect.fnUntraced(function* (version: number) {
    const ciphertext = yield* crypto_(() =>
      sealValue({
        projectPublicKey,
        slot: { ...binding, name, version },
        value,
      }),
    );
    return yield* api.secrets.write({
      params: { projectId: project.id, name },
      payload: { version, keyVersion: project.keyVersion, ciphertext },
    });
  });

  // Another writer may take the slot between the read and the write: seal again for the next
  // one, once. A second loss is reported, with the slot the store names.
  return yield* writeAs(latest + 1).pipe(
    Effect.catchTag('VersionConflictError', conflict =>
      conflict.keyVersion === project.keyVersion
        ? writeAs(conflict.latestVersion + 1)
        : Effect.fail(conflict),
    ),
  );
});

/** What a command reports of a value: never the value. */
export const describeWrite = (
  project: Project,
  secret: { readonly name: string; readonly currentVersion: number | null },
  value: string,
) => ({
  project: project.name,
  name: secret.name,
  version: secret.currentVersion,
  length: value.length,
});
