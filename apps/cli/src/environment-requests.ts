// An environment request from the terminal's side: `baymutt ask create-environment` names a new
// environment and why; the owner approves by creating it, or rejects it. It gives nobody access.
import type { EnvironmentRequest } from '@baymutt/api';
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import { listEnvironments } from './environments.ts';
import { answerFor, usage } from './errors.ts';
import { openStoredName } from './names.ts';
import type { Outcome } from './outcome.ts';
import { ServiceAccount } from './service-account.ts';
import { Settings } from './settings.ts';

const POLL_EVERY = Duration.seconds(2);

/** Where the owner answers environment request `id`: the dashboard's page for an `ask create-environment`. */
export const environmentRequestUrl = Effect.fn('environmentRequests.url')(function* (id: string) {
  const { origin } = yield* Settings;
  return `${origin}/ask/create-environment/${id}`;
});

/** The environment a request asks for, as `<org>/<name>`: its name opened with the org's names key. */
const addressOf = Effect.fn('environmentRequests.address')(function* (request: EnvironmentRequest) {
  const { namesKeys } = yield* listEnvironments();
  const name = yield* openStoredName(namesKeys.get(request.orgId) ?? null, {
    scopeId: request.orgId,
    stored: { name: request.name, sealedName: request.sealedName },
  });
  return `${request.orgSlug}/${name}`;
});

/** Waits up to `timeout` seconds for the owner's answer to an environment request, and says what it was. */
export const settleEnvironmentRequest = Effect.fn('environmentRequests.settle')(function* (
  request: EnvironmentRequest,
  timeout: number,
) {
  const { api } = yield* ServiceAccount;
  // None: the store no longer has it.
  const latest = api.environmentRequests.get({ params: { id: request.id } }).pipe(
    answerFor(request.id),
    Effect.asSome,
    Effect.catchTag('NotFoundError', () => Effect.succeedNone),
  );
  const answered =
    request.status === 'pending'
      ? yield* latest.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(POLL_EVERY),
            until: current => Option.isNone(current) || current.value.status !== 'pending',
          }),
          Effect.timeoutOption(Duration.seconds(timeout)),
        )
      : Option.some(Option.some(request));

  if (Option.isNone(answered)) {
    return {
      kind: 'unanswered',
      result: {
        id: request.id,
        status: 'pending',
        url: yield* environmentRequestUrl(request.id),
        next: `Run \`baymutt ask wait ${request.id}\` to keep waiting.`,
      },
      failure: usage(
        `The owner has not answered environment request ${request.id} yet. It waits an hour from when it was asked: run \`baymutt ask wait ${request.id}\` to keep waiting.`,
        'differs',
      ),
    } satisfies Outcome;
  }
  const current = answered.value;
  if (Option.isNone(current)) {
    return {
      kind: 'refused',
      status: 'gone',
      failure: usage(
        `Environment request ${request.id} is gone: the store no longer has it. Nothing was created.`,
        'noAccess',
      ),
    } satisfies Outcome;
  }
  const { status } = current.value;
  if (status === 'approved') {
    return {
      kind: 'granted',
      result: { id: request.id, status, environment: yield* addressOf(current.value) },
    } satisfies Outcome;
  }
  return {
    kind: 'refused',
    status,
    failure: usage(
      status === 'expired'
        ? `Nobody answered environment request ${request.id} within an hour, so it expired and nothing was created. Run \`baymutt ask create-environment\` again when the owner is around.`
        : `The owner rejected environment request ${request.id}. Nothing was created.`,
      'noAccess',
    ),
  } satisfies Outcome;
});
