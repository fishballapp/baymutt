// A plan document made into what the store takes (`POST /plans`), on this computer: each address
// found as an environment id, each new name sealed, each `access` step's key made and vouched for,
// and each proposed value read and each hint taken, and sealed to the owner's account key. Nothing is sent from here,
// and anything that cannot be resolved is refused, naming its path, before anything is.
import { hostname } from 'node:os';
import { CommandSchema, LifetimeSchema, type NewPlan } from '@baymutt/api';
import {
  generateServiceAccountToken,
  type NamesKey,
  nameIndex,
  sealHint,
  sealName,
  sealProposedValue,
  serviceAccountKeyFromToken,
  vouchForServiceAccount,
} from '@baymutt/keys';
import * as Effect from 'effect/Effect';
import * as Redacted from 'effect/Redacted';
import * as Schema from 'effect/Schema';
import { durationMs } from './about.ts';
import { listEnvironments } from './environments.ts';
import { crypto_, usage } from './errors.ts';
import { commandLine } from './key-files.ts';
import { openStoredName } from './names.ts';
import type { PlanDocument, PlanDocumentStep, SecretsItem } from './plan-document.ts';
import type { AskedStep, KeptPlan } from './plans.ts';
import { readProposedValue } from './proposed-values.ts';
import { ServiceAccount } from './service-account.ts';

const HOUR_MS = 3600 * 1000;

const isLifetime = Schema.is(LifetimeSchema);
const isCommand = Schema.is(CommandSchema);

/** "Agent on <this computer's name>", within a name's 60 characters. */
const defaultName = () => `Agent on ${hostname().slice(0, 51).trim() || 'this computer'}`;

type NewStep = NewPlan['steps'][number];

/** A key an `access` step makes: kept in a file here before the plan is sent. */
export type NewKey = {
  readonly id: string;
  readonly token: Redacted.Redacted<string>;
  readonly command: ReadonlyArray<string> | null;
};

/** A list the document guarantees is not empty, as the API's non-empty array type. */
const nonEmpty = <A>(items: ReadonlyArray<A>) => {
  const [first, ...rest] = items;
  if (first === undefined) throw new Error('a plan document held an empty list');
  return [first, ...rest] as const;
};

/** `expires` as the API takes it: a lifetime, `never`, or `fallback` when it was not given. */
export const endOf = <F extends 'never' | 'keep' | number>(
  expires: string | undefined,
  fallback: F,
  path: string,
) =>
  Effect.gen(function* () {
    if (expires === undefined) return fallback;
    if (expires === 'never') return 'never' as const;
    const lifetime = yield* durationMs(expires);
    if (!isLifetime(lifetime)) {
      return yield* usage(`${path}: a key lasts between one minute and ten years.`);
    }
    return lifetime;
  });

/** A command a key is piped into, refused when the owner's screen cannot show it as one line. */
export const checkCommand = (command: ReadonlyArray<string>, path: string) =>
  isCommand(commandLine(command))
    ? Effect.void
    : Effect.fail(
        usage(`${path}.command: longer than the owner's screen takes: 500 characters as one line.`),
      );

/**
 * The org of a plan that names no environment: that of the keys its `change` steps name, each one
 * this login asked for, all in one org.
 */
const orgOfKeys = Effect.fnUntraced(function* (plan: PlanDocument) {
  const { api, key } = yield* ServiceAccount;
  const { credentials } = yield* api.credentials.list();
  const slugs = yield* Effect.forEach(
    plan.steps,
    (step, index) => {
      if (step.type !== 'change') return Effect.succeed(null);
      const found = credentials.find(
        ({ id, parentId }) => id === step.key && parentId === key.credentialId,
      );
      return found?.org === null || found?.org === undefined
        ? Effect.fail(
            usage(
              `steps[${index}].key: no key this CLI login asked for has the id ${step.key}. See them with \`baymutt key list\`.`,
              'notFound',
            ),
          )
        : Effect.succeed({ slug: found.org.slug, index });
    },
    { concurrency: 1 },
  );
  const [first, ...rest] = slugs.flatMap(each => (each === null ? [] : [each]));
  if (first === undefined) {
    return yield* Effect.die('a plan named neither an environment nor a key');
  }
  const elsewhere = rest.find(({ slug }) => slug !== first.slug);
  if (elsewhere !== undefined) {
    return yield* usage(
      `steps[${elsewhere.index}].key: a plan asks in one org, and this one changes keys of ${first.slug} and ${elsewhere.slug}. Make one plan per org.`,
    );
  }
  return first.slug;
});

/**
 * `plan`, all of whose addresses name `orgSlug`, as the store takes it, with what this computer
 * keeps of it before it is sent: the record `ask wait` checks the answer against, and each new key.
 * With no `orgSlug` (no address named), the plan is in the org of the keys it changes.
 */
export const makePlan = Effect.fn('plans.make')(function* ({
  plan,
  orgSlug: named,
}: {
  readonly plan: PlanDocument;
  readonly orgSlug: string | null;
}) {
  const serviceAccount = yield* ServiceAccount;
  const { api, key } = serviceAccount;
  const orgSlug = named ?? (yield* orgOfKeys(plan));
  // The account key this login pinned at pairing: never one taken on the store's word.
  const account = yield* serviceAccount.pinnedAccount;
  const [{ orgs }, { environments, namesKeys }] = yield* Effect.all(
    [api.orgs.list(), listEnvironments()],
    { concurrency: 2 },
  );
  const org = orgs.find(({ slug }) => slug === orgSlug);
  if (org === undefined) {
    return yield* usage(
      `The plan names environments of ${orgSlug}, and none of your orgs is ${orgSlug}. See them with \`baymutt org list\`.`,
      'notFound',
    );
  }
  const namesKey: NamesKey | null = namesKeys.get(org.id) ?? null;
  if (namesKey === null) {
    return yield* usage(
      `The names in ${orgSlug} are not sealed yet, so it takes no plan. The owner's dashboard seals them the next time it is opened; then ask again.`,
      'conflict',
    );
  }
  const isRestoring = plan.steps.some(
    step => step.type === 'environments' && step.items.some(({ op }) => op === 'restore'),
  );
  const binned = isRestoring
    ? yield* Effect.flatMap(api.bin.list(), ({ environments: inBin }) =>
        Effect.forEach(
          inBin.filter(environment => environment.orgId === org.id),
          ({ id, name, sealedName }) =>
            Effect.map(
              openStoredName(namesKey, { scopeId: org.id, stored: { name, sealedName } }),
              opened => ({ id, address: `${orgSlug}/${opened}` }),
            ),
          { concurrency: 'unbounded' },
        ),
      )
    : [];

  const planId = crypto.randomUUID();
  /** Environments earlier steps create or restore, by address: later steps name them by these ids. */
  const brought = new Map<string, string>();
  const live = (address: string) =>
    environments.find(
      environment => environment.orgId === org.id && environment.address === address,
    );
  const environmentOf = (address: string, path: string) => {
    const id = brought.get(address) ?? live(address)?.id;
    return id === undefined
      ? Effect.fail(
          usage(
            `${path}: ${address} is not an environment of ${orgSlug}, and no earlier step creates or restores it. See them with \`baymutt env list\`; for a new one, put an \`environments\` step that creates it before this step.`,
            'notFound',
          ),
        )
      : Effect.succeed(id);
  };
  const nameOf = (address: string) => address.slice(orgSlug.length + 1);

  const secretItem = Effect.fnUntraced(function* (
    item: SecretsItem,
    { stepIndex, path }: { readonly stepIndex: number; readonly path: string },
  ) {
    const environmentId = yield* environmentOf(item.environment, `${path}.environment`);
    const scope = { scopeId: environmentId, name: item.name };
    if (item.op === 'delete' || item.op === 'restore' || item.op === 'rollback') {
      const name = yield* crypto_(() => nameIndex(namesKey, scope));
      return item.op === 'rollback'
        ? { op: item.op, environmentId, name, version: item.version }
        : { op: item.op, environmentId, name };
    }
    const sealed = yield* crypto_(() => sealName(namesKey, scope));
    const slot = { environmentId, name: sealed.name, sealedName: sealed.sealedName };
    // Sealed like a proposed value: an agent may have written one into it.
    const sealTo = { loginKey: key.privateKey, accountPublicKey: account.publicKey };
    const itemSlot = { planId, stepIndex, environmentId, name: item.name };
    if (item.op === 'paste') {
      const { hint } = item;
      if (hint === undefined) return { op: item.op, ...slot };
      const sealedHint = yield* crypto_(() => sealHint({ ...sealTo, slot: itemSlot, hint }));
      return { op: item.op, ...slot, sealedHint };
    }
    if (item.op !== 'set') return { op: item.op, ...slot };
    const value = yield* readProposedValue({ from: item.from, name: item.name, path });
    const box = yield* crypto_(() =>
      sealProposedValue({ ...sealTo, slot: itemSlot, value: Redacted.value(value) }),
    );
    return { op: item.op, ...slot, value: box };
  });

  /** One step as the store takes it, what is kept of it, and the key it makes. */
  const makeStep = Effect.fnUntraced(function* (step: PlanDocumentStep, index: number) {
    const path = `steps[${index}]`;
    const reason = step.reason === undefined ? {} : { reason: step.reason };
    switch (step.type) {
      case 'environments': {
        const items = yield* Effect.forEach(
          step.items,
          Effect.fnUntraced(function* ({ op, environment }, position) {
            const at = `${path}.items[${position}].environment`;
            if (op === 'delete') {
              return { op, environmentId: yield* environmentOf(environment, at) };
            }
            if (op === 'restore') {
              const inBin = binned.find(({ address }) => address === environment);
              if (inBin === undefined) {
                return yield* usage(
                  `${at}: ${environment} is not in the bin of ${orgSlug}. See it with \`baymutt bin list\`.`,
                  'notFound',
                );
              }
              return { op, environmentId: inBin.id };
            }
            if (live(environment) !== undefined || brought.has(environment)) {
              return yield* usage(`${at}: ${environment} already exists.`, 'conflict');
            }
            const environmentId = crypto.randomUUID();
            const sealed = yield* crypto_(() =>
              sealName(namesKey, { scopeId: org.id, name: nameOf(environment) }),
            );
            return { op, environmentId, ...sealed };
          }),
          { concurrency: 1 },
        );
        // Only later steps name what this one brings.
        for (const [position, item] of items.entries()) {
          const environment = step.items[position]?.environment;
          if (environment !== undefined && item.op !== 'delete') {
            brought.set(environment, item.environmentId);
          }
        }
        return {
          step: { type: step.type, ...reason, items: nonEmpty(items) } satisfies NewStep,
          asked: { type: step.type } satisfies AskedStep,
          key: null,
        };
      }
      case 'access': {
        const read = yield* Effect.forEach(
          step.read,
          (address, position) => environmentOf(address, `${path}.read[${position}]`),
          { concurrency: 1 },
        );
        const command = step.command ?? null;
        if (command !== null) yield* checkCommand(command, path);
        const end = yield* endOf(step.expires, command === null ? HOUR_MS : 'never', path);
        // The new key names this login as its maker, so it takes the account key this login vouches for.
        const token = generateServiceAccountToken(key.publicKey);
        const made = yield* crypto_(() => serviceAccountKeyFromToken(token));
        const vouchers = yield* crypto_(() =>
          vouchForServiceAccount({
            makerKey: key.privateKey,
            accountId: account.id,
            accountPublicKey: account.publicKey,
            serviceAccount: { id: made.credentialId, publicKey: made.publicKey },
          }),
        );
        return {
          step: {
            type: step.type,
            ...reason,
            key: {
              id: made.credentialId,
              name: step.name ?? defaultName(),
              publicKey: made.publicKey,
              bearerHash: made.bearerHash,
              vouchers,
            },
            command: command === null ? null : commandLine(command),
            end,
            read: nonEmpty(read),
          } satisfies NewStep,
          asked: { type: step.type, keyId: made.credentialId, read } satisfies AskedStep,
          key: { id: made.credentialId, token: Redacted.make(token), command } satisfies NewKey,
        };
      }
      case 'change': {
        const resolve = (field: 'read' | 'giveBack') =>
          Effect.forEach(
            step[field] ?? [],
            (address, position) => environmentOf(address, `${path}.${field}[${position}]`),
            { concurrency: 1 },
          );
        const read = yield* resolve('read');
        const giveBack = yield* resolve('giveBack');
        const end = yield* endOf(step.expires, 'keep', path);
        return {
          step: {
            type: step.type,
            ...reason,
            keyId: step.key,
            end,
            read,
            giveBack,
          } satisfies NewStep,
          asked: {
            type: step.type,
            keyId: step.key,
            read,
            giveBack,
            asksNewEnd: end !== 'keep',
          } satisfies AskedStep,
          key: null,
        };
      }
      case 'secrets': {
        const items = yield* Effect.forEach(
          step.items,
          (item, position) =>
            secretItem(item, { stepIndex: index, path: `${path}.items[${position}]` }),
          { concurrency: 1 },
        );
        return {
          step: { type: step.type, ...reason, items: nonEmpty(items) } satisfies NewStep,
          asked: { type: step.type } satisfies AskedStep,
          key: null,
        };
      }
    }
  });

  // In order: a step finds an environment by the id an earlier one gave it.
  const made = yield* Effect.forEach(plan.steps, makeStep, { concurrency: 1 });
  return {
    org,
    payload: {
      id: planId,
      orgId: org.id,
      reason: plan.reason,
      steps: nonEmpty(made.map(({ step }) => step)),
    } satisfies NewPlan,
    kept: {
      id: planId,
      steps: made.map(({ asked }) => ({ asked })),
    } satisfies KeptPlan,
    keys: made.flatMap(({ key: made }) => (made === null ? [] : [made])),
  };
});
