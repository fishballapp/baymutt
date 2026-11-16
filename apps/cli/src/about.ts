// What a new CLI login's maker may say about it: what it is for, and when it stops working. And how
// long, as `--expires` takes it everywhere: minutes, hours or days.
import { DescriptionSchema } from '@baymutt/api';
import * as Clock from 'effect/Clock';
import * as Flag from 'effect/cli/Flag';
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import { usage } from './errors.ts';

const MINUTE_MS = 60 * 1000;
const UNIT_MS = { m: MINUTE_MS, h: 60 * MINUTE_MS, d: 24 * 60 * MINUTE_MS } as const;
const DURATION = /^(?<count>[1-9][0-9]{0,4})(?<unit>[mhd])$/u;

/** `--expires` as milliseconds: a count of minutes, hours or days, such as 15m, 12h or 90d. */
export const durationMs = (text: string) => {
  const { count, unit } = DURATION.exec(text)?.groups ?? {};
  if (count === undefined || (unit !== 'm' && unit !== 'h' && unit !== 'd')) {
    return Effect.fail(
      usage(`--expires takes minutes, hours or days, such as 15m, 12h or 90d, not "${text}".`),
    );
  }
  return Effect.succeed(Number(count) * UNIT_MS[unit]);
};

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
      'Stop working after this long: minutes, hours or days from now, such as 15m, 12h or 90d. Omit for never. The owner can change it in the dashboard',
    ),
    Flag.optional,
  ),
};

/** `--expires` as the time it ends, in epoch milliseconds. */
export const expiresAt = (expires: Option.Option<string>) =>
  Effect.gen(function* () {
    if (Option.isNone(expires)) return undefined;
    return (yield* Clock.currentTimeMillis) + (yield* durationMs(expires.value));
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
