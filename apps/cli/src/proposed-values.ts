// A value an ask proposes, read on this computer from where its `set` item says it is: a file, an
// environment variable, or one variable of a dotenv file. The ask names only where; the value goes
// nowhere but into a box sealed to the owner's account key, and no message here carries it.
import { parseEnv } from 'node:util';
import { MAX_VALUE_BYTES } from '@baymutt/api';
import * as Config from 'effect/Config';
import * as Effect from 'effect/Effect';
import * as FileSystem from 'effect/FileSystem';
import * as Option from 'effect/Option';
import * as Redacted from 'effect/Redacted';
import type { ValueSource } from './ask-document.ts';
import { usage } from './errors.ts';

/** A file's whole content; refused, naming `path`, when there is none to read. */
const readFile = Effect.fnUntraced(function* (file: string, path: string) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchReason('PlatformError', 'NotFound', () =>
      Effect.fail(usage(`${path}: there is no file ${file} on this computer.`, 'notFound')),
    ),
    Effect.catchTag('PlatformError', error =>
      Effect.fail(usage(`${path}: ${file} could not be read: ${error.message}`)),
    ),
  );
});

/**
 * The value `from` names, for the item at `path` (`steps[i].items[j]`), whose secret is `name`.
 * Refused, before anything is sent, when it is not there, is empty, or is larger than a value may
 * be.
 */
export const readProposedValue = Effect.fn('proposedValues.read')(function* ({
  from,
  name,
  path,
}: {
  readonly from: ValueSource;
  readonly name: string;
  readonly path: string;
}) {
  const value = yield* (() => {
    if ('file' in from) return readFile(from.file, `${path}.from.file`);
    if ('env' in from) {
      return Config.option(Config.String(from.env)).pipe(
        Effect.orDie,
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                usage(
                  `${path}.from.env: ${from.env} is not set in this environment, or is empty.`,
                  'notFound',
                ),
              ),
            onSome: Effect.succeed,
          }),
        ),
      );
    }
    const variable = from.key ?? name;
    return readFile(from.dotenv, `${path}.from.dotenv`).pipe(
      Effect.flatMap(text => {
        const parsed = parseEnv(text);
        const found = Object.hasOwn(parsed, variable) ? parsed[variable] : undefined;
        return found === undefined
          ? Effect.fail(
              usage(
                `${path}.from: ${from.dotenv} has no ${variable}.${from.key === undefined ? ' Name the variable with "key" when it is not the secret’s name.' : ''}`,
                'notFound',
              ),
            )
          : Effect.succeed(found);
      }),
    );
  })();
  if (value === '') return yield* usage(`${path}.from: the value there is empty.`);
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_VALUE_BYTES) {
    return yield* usage(
      `${path}.from: the value there is ${bytes} bytes, and a value may be ${MAX_VALUE_BYTES}.`,
    );
  }
  return Redacted.make(value);
});
