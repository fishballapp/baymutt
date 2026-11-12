#!/usr/bin/env node
import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
import * as NodeServices from '@effect/platform-node/NodeServices';
import * as Command from 'effect/cli/Command';
import * as Effect from 'effect/Effect';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as Layer from 'effect/Layer';
import packageJson from '../package.json' with { type: 'json' };
import { CliLayer, cli } from './app.ts';

Command.run(cli, { version: packageJson.version }).pipe(
  Effect.provide(
    Layer.mergeAll(FetchHttpClient.layer, CliLayer).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
  // A failure has already been printed as one JSON line (`report`); its exit code rides on the error.
  NodeRuntime.runMain({ disableErrorReporting: true }),
);
