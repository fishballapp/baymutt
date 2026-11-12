import * as HttpRouter from 'effect/http/HttpRouter';
import * as Layer from 'effect/Layer';
import { HttpApp } from './http/app.ts';
import { runtime, WorkerLive } from './runtime.ts';

// Built once per isolate, at module load: `toWebHandler` builds the app layer (and, through the
// runtime's memo map, the services) right away, so no layer may do I/O while it builds.
const { handler } = HttpRouter.toWebHandler(HttpApp.pipe(Layer.provideMerge(WorkerLive)), {
  memoMap: runtime.memoMap,
  disableLogger: true,
});

/** No dashboard page has a dot in its last segment; every built file does. */
const isFilePath = (pathname: string) => pathname.slice(pathname.lastIndexOf('/')).includes('.');

export default {
  // Not `fetch: handler`: the handler's 2nd parameter is an Effect `Context`, not the Workers
  // `env`. A request reaches this Worker for /api/*, or for a path no file in dist/ answers: one of
  // the dashboard's pages, which its client router draws from the shell (wrangler.jsonc). The
  // shell comes through ASSETS, so _headers applies to it as to every file.
  fetch: (request, env) => {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) return handler(request);
    // A missing file (a chunk an older page still asks for) is a 404, never the shell's HTML.
    if (isFilePath(pathname)) return env.ASSETS.fetch(request);
    return env.ASSETS.fetch(new Request(new URL('/_shell', request.url), request));
  },
} satisfies ExportedHandler<Env>;
