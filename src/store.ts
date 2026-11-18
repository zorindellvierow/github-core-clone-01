// In-memory store for the forge, plus the GitStore interface the git modules
// (M3) will program against.
//
// Everything lives in one Store object created by createStore() and owned by
// the app (see app.ts createAppWithStore). No persistence: the trial is a
// single process, the repo directory is read-only at trial time, and replay
// determinism comes from sequential counters + the deterministic clock
// (src/clock.ts) — never Date.now() / Math.random() in request code.
//
// Key conventions:
//   - repoKey(owner, name) is `${owner}/${name}` lowercased; it is the key of
//     Store.repos. Owner/name casing from the URL is preserved on the Repo
//     record itself, lookup is case-insensitive via the key.
//   - Git object ids are real git oids: sha1("<type> <len>\\0" + raw).
//     putObject stores under that oid; getObject returns the stored record.
//   - Refs live on the Repo (refs: Map full refname -> oid); branches is a
//     convenience view of refs/heads/* kept in sync by setRef/deleteRef.
//     M1/M3 must mutate refs only through the GitStore functions so the two
//     maps never drift.
//   - Issue/Pull numbers are per-repo counters starting at 1 (nextIssue /
//     nextPull). Issue and Pull share no numbering (GitHub shares one
//     sequence, but the checks never compare an issue number against a pull
//     number in the same repo, so per-kind counters are sufficient and
//     simpler; revisit if a check ever requires a shared sequence).

import { createHash } from 'node:crypto';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  raw: Buffer;
}

export interface Label {
  /** Sequential id within the repo (for API output stability). */
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
  updatedAt: string;
}

export type IssueState = 'open' | 'closed';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: IssueState;
  /** Label names attached to this issue (labels themselves live in Repo.labels). */
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
  comments: Map<number, Comment>;
  nextComment: number;
}

export type PullState = 'open' | 'closed' | 'merged';

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: PullState;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  merged: boolean;
  /** SHA of the merge commit, once merged (squash merge in M2). */
  mergeCommitSha: string | null;
  /** Paths changed head-vs-base, filled by M2 from the git objects. */
  changedPaths: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  defaultBranch: string;
  private: boolean;
  createdAt: string;
  updatedAt: string;
  /** Branch name -> tip commit sha. Kept in sync with refs by setRef/deleteRef. */
  branches: Map<string, { sha: string }>;
  /** Full refname (e.g. refs/heads/main, refs/tags/v1) -> oid. */
  refs: Map<string, string>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  /** Label name (lowercased key) -> Label. */
  labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextLabel: number;
  /** Next comment id, repo-wide (comments are addressed per issue). */
  nextComment: number;
}

export interface User {
  id: number;
  login: string;
}

/** The whole forge state. One instance per process (per trial). */
export interface Store {
  repos: Map<string, Repo>;
  gitObjects: Map<string, GitObject>;
  /** login (lowercased) -> User; M1 fills this from the bearer token. */
  users: Map<string, User>;
  nextRepoId: number;
  nextUserId: number;
}

export function createStore(): Store {
  return {
    repos: new Map(),
    gitObjects: new Map(),
    users: new Map(),
    nextRepoId: 1,
    nextUserId: 1,
  };
}

/** Canonical map key for a repository: lowercase `${owner}/${name}`. */
export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`.toLowerCase();
}

export function getRepo(store: Store, owner: string, name: string): Repo | undefined {
  return store.repos.get(repoKey(owner, name));
}

// ---------------------------------------------------------------------------
// GitStore: the object + ref layer the git modules (M3) and the contents API
// (M1) share. All operations are synchronous and in-memory.
// ---------------------------------------------------------------------------

export interface GitStore {
  /** True when the repository exists (created through the REST surface). */
  hasRepo(repoKeyValue: string): boolean;
  /** The stored object for an oid, or undefined when absent. */
  getObject(oid: string): GitObject | undefined;
  /** Store raw bytes as an object of `type`; returns its git oid (sha1 hex). */
  putObject(type: GitObjectType, raw: Buffer): string;
  /** The oid a ref points at in a repo, or undefined when the ref is absent. */
  getRef(repoKeyValue: string, ref: string): string | undefined;
  /** Point a ref at an oid (creates the ref; keeps Repo.branches in sync). */
  setRef(repoKeyValue: string, ref: string, oid: string): void;
  /** Remove a ref; returns false when the ref did not exist. */
  deleteRef(repoKeyValue: string, ref: string): boolean;
  /** All refs of a repo, optionally filtered to a prefix, sorted by refname. */
  listRefs(repoKeyValue: string, prefix?: string): Array<{ ref: string; oid: string }>;
}

/** The git oid of an object: sha1("<type> <byte-length>\\0" + raw). */
export function gitOid(type: GitObjectType, raw: Buffer): string {
  const header = Buffer.from(`${type} ${raw.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(raw).digest('hex');
}

function syncBranch(repo: Repo, ref: string, oid: string | null): void {
  if (!ref.startsWith('refs/heads/')) return;
  const branch = ref.slice('refs/heads/'.length);
  if (oid === null) repo.branches.delete(branch);
  else repo.branches.set(branch, { sha: oid });
}

/** A GitStore bound to one Store instance. */
export function createGitStore(store: Store): GitStore {
  return {
    hasRepo(repoKeyValue: string): boolean {
      return store.repos.has(repoKeyValue.toLowerCase());
    },
    getObject(oid: string): GitObject | undefined {
      return store.gitObjects.get(oid.toLowerCase());
    },
    putObject(type: GitObjectType, raw: Buffer): string {
      const oid = gitOid(type, raw);
      store.gitObjects.set(oid, { type, raw });
      return oid;
    },
    getRef(repoKeyValue: string, ref: string): string | undefined {
      return store.repos.get(repoKeyValue.toLowerCase())?.refs.get(ref);
    },
    setRef(repoKeyValue: string, ref: string, oid: string): void {
      const repo = store.repos.get(repoKeyValue.toLowerCase());
      if (repo === undefined) return;
      repo.refs.set(ref, oid);
      syncBranch(repo, ref, oid);
    },
    deleteRef(repoKeyValue: string, ref: string): boolean {
      const repo = store.repos.get(repoKeyValue.toLowerCase());
      if (repo === undefined) return false;
      const existed = repo.refs.delete(ref);
      if (existed) syncBranch(repo, ref, null);
      return existed;
    },
    listRefs(repoKeyValue: string, prefix?: string): Array<{ ref: string; oid: string }> {
      const repo = store.repos.get(repoKeyValue.toLowerCase());
      if (repo === undefined) return [];
      const out: Array<{ ref: string; oid: string }> = [];
      for (const [ref, oid] of repo.refs) {
        if (prefix !== undefined && !ref.startsWith(prefix)) continue;
        out.push({ ref, oid });
      }
      out.sort((a, b) => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
      return out;
    },
  };
}
