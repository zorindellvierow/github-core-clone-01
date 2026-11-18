// Mount point for the git smart-HTTP layer.
//
// The app (app.ts, owned by builder M0) wires this in before its JSON 404
// fallback:
//
//   import { mountGit } from './git/routes.ts';
//   import { createMemoryStore } from './store.ts'; // or whatever store M0 builds
//
//   const git = mountGit(store);
//   // inside the request handler, before the other routes:
//   if (git(req, res, pathname, method)) return;
//
// `mountGit(store)` returns a handler `(req, res, pathname, method) => boolean`:
// it returns true (and answers the request asynchronously) when the path is
// `/{owner}/{repo}.git/info/refs`, `/{owner}/{repo}.git/git-upload-pack` or
// `/{owner}/{repo}.git/git-receive-pack`, and false for every other path so
// the app's own routing keeps working. The handler never throws; a failure
// inside it is answered with a JSON 500 when the socket is still open.
//
// The store must implement the `GitStore` interface from `./store-iface.ts`
// (repositories keyed "<owner>/<repo>"). Authorization: when
// `process.env.MAKEFUN_SHOP_TOKEN` is set (the trial always sets it on the
// entry process), the exact Bearer token is required and anything else is
// 401; when it is unset, any non-empty Bearer token is accepted. Pass
// `{ token }` explicitly to override the environment value (tests do this).

export { mountGit } from './protocol.ts';
export type { GitRequestHandler, MountGitOptions } from './protocol.ts';
export type { GitObjectType, GitRef, GitStore, StoredGitObject } from './store-iface.ts';
export { DEFAULT_BRANCH, ZERO_OID } from './protocol.ts';
