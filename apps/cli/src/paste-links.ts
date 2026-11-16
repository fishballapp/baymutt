// A paste link from the terminal's side, once made: waiting for the owner to paste through it.
import * as Duration from 'effect/Duration';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schedule from 'effect/Schedule';
import { answerFor, usage } from './errors.ts';
import { print } from './output.ts';
import { ServiceAccount } from './service-account.ts';

const POLL_EVERY = Duration.seconds(3);

/** Waits up to `timeout` seconds for the owner to paste through link `id`, and says how it ended. */
export const settlePasteLink = Effect.fn('pasteLinks.settle')(function* (
  id: string,
  timeout: number,
) {
  const { api } = yield* ServiceAccount;
  const settled = yield* api.pasteLinks.get({ params: { id } }).pipe(
    answerFor(id),
    Effect.repeat({
      schedule: Schedule.spaced(POLL_EVERY),
      until: link => link.status !== 'pending',
    }),
    Effect.timeoutOption(Duration.seconds(timeout)),
  );
  if (Option.isNone(settled)) {
    yield* print({ id, status: 'pending' });
    return yield* usage(
      `Nobody has answered this paste link in ${timeout} seconds. It waits an hour from when it was made: run \`baymutt ask wait ${id}\` again, or ask the owner to answer it under Paste links in the dashboard.`,
      'differs',
    );
  }
  const { status } = settled.value;
  if (status === 'expired') {
    return yield* usage(
      `Nobody answered paste link ${id} within an hour, so it expired. Run \`baymutt ask paste-link\` again when the owner is around.`,
      'noAccess',
    );
  }
  if (status === 'cancelled') {
    return yield* usage(
      `Paste link ${id} was dismissed or withdrawn, or replaced by a newer one for the same name. No value was pasted through it.`,
      'noAccess',
    );
  }
  yield* print({ id, status });
});
