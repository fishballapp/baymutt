// Names the store cannot read. Each org has a names key, wrapped by the owner to this key; it opens
// with the account public key this key already trusts, never with the one the store serves. An org
// whose names are not sealed yet has no names key, and its names are stored as written.
import type { OrgNamesKeyWrap } from '@baymutt/api';
import { type NamesKey, nameIndex, openName, openNamesKey } from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { crypto_, type IntegrityError } from './errors.ts';
import { ServiceAccount } from './service-account.ts';

/** The names key of each org this key reaches, by org id; an org that is missing has none. */
export type NamesKeys = ReadonlyMap<string, NamesKey>;

/** A name as the store answers it. `sealedName` is missing, not null, from a 0.7 store. */
type Stored = { readonly name: string; readonly sealedName?: string | null | undefined };

/** Every names key `environments.list` handed over, opened. Asks for the account key only if there is one. */
export const openNamesKeys = Effect.fn('names.openKeys')(function* (
  wraps: ReadonlyArray<OrgNamesKeyWrap>,
) {
  if (wraps.length === 0) return new Map() as NamesKeys;
  const { key, trustedAccountKey } = yield* ServiceAccount;
  const accountPublicKey = yield* trustedAccountKey;
  const opened = yield* Effect.forEach(
    wraps,
    ({ orgId, wrap }) =>
      Effect.map(
        crypto_(() =>
          openNamesKey({
            wrap,
            orgId,
            readerKey: key.privateKey,
            readerId: key.credentialId,
            accountPublicKey,
          }),
        ),
        namesKey => [orgId, namesKey] as const,
      ),
    { concurrency: 'unbounded' },
  );
  return new Map(opened) as NamesKeys;
});

/** The name a stored one stands for, checked against the names key when the org has one. */
export const openStoredName = (
  namesKey: NamesKey | null,
  { scopeId, stored }: { readonly scopeId: string; readonly stored: Stored },
) =>
  crypto_(() =>
    openName(namesKey, {
      scopeId,
      stored: { name: stored.name, sealedName: stored.sealedName ?? null },
    }),
  );

/**
 * What the store files an existing name under: its index, or, in an org with no names key, the name
 * as written. None: the name is not there.
 *
 * With no names key the name would go out as typed, and nothing trusted says the org really is
 * unsealed: a store could hide its names keys and sealed names to learn it. So a name goes out only
 * if `listed`, the store's own list of that scope, already holds it as written. A store that hides
 * the sealing learns no name it did not hold.
 */
export const storedNameOf = <E, R>(
  namesKey: NamesKey | null,
  {
    scopeId,
    name,
    listed,
  }: {
    readonly scopeId: string;
    readonly name: string;
    readonly listed: Effect.Effect<ReadonlyArray<Stored>, E, R>;
  },
): Effect.Effect<Option.Option<string>, E | IntegrityError, R> =>
  namesKey === null
    ? Effect.map(listed, stored =>
        stored.some(each => (each.sealedName ?? null) === null && each.name === name)
          ? Option.some(name)
          : Option.none(),
      )
    : Effect.asSome(crypto_(() => nameIndex(namesKey, { scopeId, name })));
