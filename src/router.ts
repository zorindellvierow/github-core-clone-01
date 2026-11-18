// Module mount contract for the forge's router.
//
// Every feature module (M1 REST, M2 issues/pulls, M3 git, M4 GraphQL, M5 MCP)
// exports a `mount(ctx)` function that returns a RouteHandler:
//
//   export function mount(ctx: RouterContext): RouteHandler;
//
// A RouteHandler receives (req, res, pathname, method) and returns true when
// it handled the request (it wrote the response), false when the request is
// not its business. Handlers may be async: returning a Promise<boolean> is
// fine, the dispatcher awaits it. app.ts calls the mounted handlers in
// registration order and falls through to the JSON 404 when none claims the
// request.
//
// Rules for module authors:
//   - Never write the response and return false; never return true without
//     writing a response (the connection would hang).
//   - Use sendJson/jsonError from ./util.ts so every reply carries
//     X-GitHub-Request-Id and a JSON body.
//   - Use nowMs()/nowIso() from ./clock.ts for timestamps; no Date.now() /
//     Math.random() in request code.
//   - Read state only through ctx.store (and ctx.git for objects/refs).
//     Do not keep module-level mutable state: replay determinism depends on
//     all state living in the Store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GitStore, Store } from './store.ts';

/** What every mounted module receives. Extended as modules need more. */
export interface RouterContext {
  store: Store;
  git: GitStore;
}

/** A mounted module's handler: true = request handled (response written). */
export type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
) => boolean | Promise<boolean>;

/** A module's mount function: build its handler from the shared context. */
export type MountFn = (ctx: RouterContext) => RouteHandler;

/**
 * Run mounted handlers in order; returns true when one claimed the request.
 * The first handler returning true wins; later handlers are not called.
 * A handler that answers synchronously (a plain boolean) is not awaited:
 * awaiting a non-promise still costs a microtask hop per handler.
 */
export async function dispatch(
  handlers: readonly RouteHandler[],
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  for (const handler of handlers) {
    const result = handler(req, res, pathname, method);
    if (result instanceof Promise ? await result : result) return true;
  }
  return false;
}
