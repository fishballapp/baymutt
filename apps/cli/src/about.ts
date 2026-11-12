// What a new service account's maker may say about it: what it is for, and when it stops working.
// `baymutt login` and `baymutt service-accounts create` take the same two flags.
import { DescriptionSchema } from '@baymutt/api';
import * as Clock from 'effect/Clock';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { usage } from './errors.ts';

const HOUR_MS = 3600 * 1000;
const UNIT_MS = { h: HOUR_MS, d: 24 * HOUR_MS } as const;
const DURATION = /^(?<count>[1-9][0-9]{0,4})(?<unit>[hd])$/u;

export const aboutFlags = {
  description: Flag.String('description').pipe(
    Flag.withDescription(
      'What it is for, up to 140 characters, shown to the owner beside its name. Stored readable, like the name: never put a secret in it',
    ),
    Flag.withSchema(DescriptionSchema),
    Flag.optional,
  ),
  expires: Flag.String('expires').pipe(
    Flag.withDescription(
      'Stop working after this long: hours or days from now, such as 12h or 90d. Omit for never. The owner can change it in the dashboard',
    ),
    Flag.optional,
  ),
};

/** `--expires` as the time it ends, in epoch milliseconds. */
export const expiresAt = (expires: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(expires)) return undefined;
    const { count, unit } = DURATION.exec(expires.value)?.groups ?? {};
    if (count === undefined || (unit !== 'h' && unit !== 'd')) {
      return yield* usage(
        `--expires takes hours or days from now, such as 12h or 90d, not "${expires.value}".`,
      );
    }
    return (yield* Clock.currentTimeMillis) + Number(count) * UNIT_MS[unit];
  });

/** The two as the API takes them: a key only when it was given. */
export const aboutPayload = Effect.fnUntraced(function* ({
  description,
  expires,
}: {
  readonly description: Option.Option<string>;
  readonly expires: Option.Option<string>;
}) {
  const ends = yield* expiresAt(expires);
  return {
    ...(Option.isSome(description) ? { description: description.value } : {}),
    ...(ends === undefined ? {} : { expiresAt: ends }),
  };
});
