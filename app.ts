// The forge's HTTP server: health probe, API root, and the module router.
//
// app.ts owns the server and the dispatch order only. Feature work lives in
// modules that export mount(ctx) (see src/router.ts); app.ts calls them in
// registration order and falls through to a JSON 404 when none claims the
// request. main.ts (the entry <-> env lifecycle) is untouched.
//
// Dispatch order:
//   1. GET /healthz            — the env's boot check (200 {"ok":true}).
//   2. GET /api/v3[/]          — the API root (200 + x-oauth-scopes).
//   3. Mounted modules, in order (M0: none yet — the array below is the
//      extension point; M1 appends the REST mount, M3 the git mount, ...).
//   4. JSON 404 {"message":"Not Found"} for everything else, every method.
//
// Every reply goes through sendJson, so every reply carries a non-empty
// X-GitHub-Request-Id header (protocol group). Handler throws become a
// 500 {"message": ...} instead of a dropped connection.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createGitStore, createStore, type Store } from './src/store.ts';
import { mountGit } from './src/git/routes.ts';
import { mountGraphQL } from './src/graphql.ts';
import { mountIssues } from './src/issues.ts';
import { mountPulls } from './src/pulls.ts';
import { mountRest } from './src/rest.ts';
import { dispatch, type RouteHandler, type RouterContext } from './src/router.ts';
import { jsonError, sendJson } from './src/util.ts';

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

/**
 * Build the server around an existing store (testing + the trial entry).
 * Modules mount here, in order; add the next module's mount call to the
 * `mounts` array as it lands (M1 REST, M2 issues/pulls, M3 git, M4 GraphQL,
 * M5 MCP).
 */
export function createAppWithStore(store: Store): Server {
  const ctx: RouterContext = { store, git: createGitStore(store) };
  void ctx;
  const mounts: RouteHandler[] = [
    // M3: git smart HTTP (/{owner}/{repo}.git/...). First: no path overlap
    // with /api/v3/*, and git must answer before the JSON 404 fallback.
    mountGit(ctx.git),
    // M1: REST v3 (repos, contents, branches, commits, git refs, auth).
    mountRest(ctx),
    // M2: issues, labels, comments + pull requests (after REST: REST returns
    // false for the issues/labels/pulls namespaces so these claim them).
    mountIssues(ctx),
    mountPulls(ctx),
    // M4: GraphQL v4 (after pulls: mutations write to the same Store).
    mountGraphQL(ctx),
  ];

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // The GitHub API root: a 200 with the token's scopes, as api.github.com answers GET /.
        if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
          sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
          return;
        }

        // Mounted feature modules, in registration order.
        if (await dispatch(mounts, req, res, path, method)) return;

        // Everything else, every method: GitHub's 404 body.
        jsonError(res, 404, 'Not Found');
      } catch (err) {
        if (!res.headersSent) {
          jsonError(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        } else {
          res.destroy();
        }
      }
    })();
  });
}

/** Build the server with a fresh store. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createAppWithStore(createStore());
}
