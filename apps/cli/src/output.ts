// stdout carries the command's result as JSON and nothing else, so it pipes into `jq` or an
// agent's parser. Anything said to a person goes to stderr.
import * as Console from 'effect/Console';

export const print = (value: unknown) => Console.log(JSON.stringify(value, null, 2));

/** One result on one line, for a command that prints one per ask as each is answered. */
export const printLine = (value: unknown) => Console.log(JSON.stringify(value));

export const say = (line: string) => Console.error(line);
