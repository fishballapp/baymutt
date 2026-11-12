// The only module that reads `env` from `cloudflare:workers`. The layers are built eagerly, at
// isolate start, so building them must do no I/O: every binding call happens inside a request.
import { env } from 'cloudflare:workers';
import * as Layer from 'effect/Layer';
import * as Logger from 'effect/Logger';
import * as ManagedRuntime from 'effect/ManagedRuntime';
import { makeWorkerLayer } from './layer.ts';
import { Auth } from './platform/auth.ts';

export const WorkerLive = makeWorkerLayer(env, { auth: Auth.layer(env.DB) }).pipe(
  Layer.provideMerge(Logger.layer([Logger.consoleJson])),
);

export const runtime = ManagedRuntime.make(WorkerLive);
