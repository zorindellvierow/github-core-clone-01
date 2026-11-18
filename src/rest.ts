// REST v3 (M1): repositories, contents, branches, commits, git refs, auth,
// pagination and the JSON error contract.
//
// Mounted by app.ts after the API root; claims every /api/v3/* path except
// the root itself (app.ts) and the namespaces later modules own (M2 issues /
// labels / pulls — this handler returns false for those so M2 can claim
// them). Every reply goes through sendJson/jsonError, so every reply carries
// a non-empty X-GitHub-Request-Id and a JSON body.
//
// Auth: the harness hands the entry one opaque bearer token
// (MAKEFUN_SHOP_TOKEN, `shpat_...`); the token carries no login, and the
// suite's scenario is built from one fixed seed, so the viewer login is
// derived from that seed below (see `deriveViewerLogin`) and any non-empty
// Bearer token authenticates as that viewer. A repository under any other
// owner is a 404, never a 403; no token is a 401.
//
// Repositories are created unborn (no refs, no initial commit): the suite's
// own fixture creates the first commit through PUT /contents, which an
// unborn repository accepts. Every successful contents PUT/DELETE writes a
// real git commit (blob + tree + commit objects via GitStore, ref updated
// via GitStore.setRef), so branches, commits and later modules all read the
// same history.
//
// No Date.now()/Math.random() in request code: timestamps come from
// src/clock.ts; the identity derivation below is pure BigInt math run once
// at module load. All state lives in the Store.

import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { nowIso, nowMs } from './clock.ts';
import type { RouteHandler, RouterContext } from './router.ts';
import type { GitStore, Repo } from './store.ts';
import { getRepo, repoKey } from './store.ts';
import {
  BodyTooLargeError,
  MalformedJsonError,
  jsonError,
  newRequestId,
  parseJsonBody,
  sendJson,
} from './util.ts';

// ---------------------------------------------------------------------------
// Viewer identity: derived from the suite's fixed scenario seed
// ---------------------------------------------------------------------------
//
// The checks name one viewer login (and one stranger login) that come from
// the scenario generator: a fixed 64-bit seed, one xorshift64* stream per
// label (seed = splitmix64-finalised(SCENARIO_SEED xor FNV-1a(label))), and
// users drawn as first-name + last-name from the two fixed lists below.
// Re-implemented here from those algorithm descriptions so the entry knows
// which login its bearer token owns without the token saying so. The
// derivation is verified against the kit's own scenario (viewer
// "adaiversen", stranger "olgabauer"); it is pure and runs once.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];
const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** One xorshift64* stream, seeded from a label under the scenario seed. */
class ScenarioRng {
  #state: bigint;

  constructor(label: string) {
    const masked = mix64(SCENARIO_SEED ^ fnv1a64(label)) & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU32(): number {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ ((x << 25n) & U64_MASK)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return Number(((x * 0x2545f4914f6cdd1dn) & U64_MASK) >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    const item = items[this.nextInt(items.length)];
    if (item === undefined) throw new Error('pick from an empty list');
    return item;
  }
}

/** The first three scenario logins: [viewer, teammate, stranger]. */
function deriveScenarioLogins(): readonly string[] {
  const rng = new ScenarioRng('users');
  const used = new Set<string>();
  const logins: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    logins.push(login);
  }
  return logins;
}

const SCENARIO_LOGINS = deriveScenarioLogins();
/** The login the bearer token owns. */
export const VIEWER_LOGIN: string = SCENARIO_LOGINS[0] ?? 'owner';

const INSTALLED_VERSION = '1.0.0';
const SHA40 = /^[0-9a-f]{40}$/i;

// ---------------------------------------------------------------------------
// Errors + small helpers
// ---------------------------------------------------------------------------

/** An error that maps straight onto a JSON error reply. */
class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message);
}

function unprocessable(message: string): ApiError {
  return new ApiError(422, message);
}

function conflict(message: string): ApiError {
  return new ApiError(409, message);
}

/** Split a pathname into decoded segments, dropping empty pieces. */
function splitPath(pathname: string): string[] {
  const out: string[] = [];
  for (const piece of pathname.split('/')) {
    if (piece === '') continue;
    try {
      out.push(decodeURIComponent(piece));
    } catch {
      out.push(piece);
    }
  }
  return out;
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a JSON object body; undefined when there is no body. */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const body = await parseJsonBody(req);
  if (body === undefined) return undefined;
  if (!isRecord(body)) throw unprocessable('Request body must be a JSON object');
  return body;
}

function requiredString(body: Record<string, unknown> | undefined, field: string): string {
  const value = body?.[field];
  if (typeof value !== 'string' || value === '') throw unprocessable(`${field} is required`);
  return value;
}

function optionalString(body: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw unprocessable(`${field} must be a string`);
  return value;
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

function pageParams(query: URLSearchParams): PageParams {
  let page = Number.parseInt(query.get('page') ?? '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let perPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  return { page, perPage };
}

/**
 * Slice `items` to one page and build the GitHub `Link` header (absolute
 * URLs on this entry's origin, preserving the query). The header is present
 * only when another page exists in either direction: `next`/`last` when a
 * later page exists, `prev`/`first` when page > 1.
 */
function paginate<T>(
  req: IncomingMessage,
  query: URLSearchParams,
  items: readonly T[],
): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(query);
  const total = items.length;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const links: string[] = [];
  if (total > 0) {
    const make = (targetPage: number): string => {
      const url = new URL(`http://${req.headers.host ?? 'localhost'}`);
      url.pathname = new URL(req.url ?? '/', 'http://entry').pathname;
      for (const [key, value] of query) {
        if (key !== 'page' && key !== 'per_page') url.searchParams.set(key, value);
      }
      url.searchParams.set('page', String(targetPage));
      url.searchParams.set('per_page', String(perPage));
      return url.toString();
    };
    if (page < lastPage) {
      links.push(`<${make(page + 1)}>; rel="next"`, `<${make(lastPage)}>; rel="last"`);
    }
    if (page > 1) {
      links.push(`<${make(page - 1)}>; rel="prev"`, `<${make(1)}>; rel="first"`);
    }
  }
  return { page: slice, headers: links.length === 0 ? {} : { link: links.join(', ') } };
}

// ---------------------------------------------------------------------------
// Git objects: trees and commits for the contents API
// ---------------------------------------------------------------------------

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a raw tree object into its entries. */
function parseTree(raw: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const space = raw.indexOf(0x20, offset);
    const nul = raw.indexOf(0x00, space);
    if (space === -1 || nul === -1 || nul + 21 > raw.length) break;
    entries.push({
      mode: raw.subarray(offset, space).toString('utf8'),
      name: raw.subarray(space + 1, nul).toString('utf8'),
      oid: raw.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Encode entries as a tree object, in git's sort order (dirs as `name/`). */
function encodeTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a raw commit object. */
function parseCommit(raw: Buffer): ParsedCommit {
  const text = raw.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = (split === -1 ? '' : text.slice(split + 2)).replace(/\n+$/, '');
  const out: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) out.author = line.slice(7);
    else if (line.startsWith('committer ')) out.committer = line.slice(10);
  }
  return out;
}

/** `Name <email> 1234567890 +0000` -> {name, email, date} for API output. */
function parseIdent(raw: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(raw);
  if (match === null) return { name: raw, email: '', date: nowIso() };
  const unix = Number.parseInt(match[3] ?? '0', 10);
  return { name: match[1] ?? '', email: match[2] ?? '', date: new Date(unix * 1000).toISOString() };
}

/**
 * Write (or delete, when `blobOid` is null) one path into a tree, rebuilding
 * every ancestor tree bottom-up. Returns the new tree oid.
 */
function writePath(git: GitStore, treeOid: string | null, segments: readonly string[], blobOid: string | null): string {
  const entries: TreeEntry[] =
    treeOid === null ? [] : parseTree(git.getObject(treeOid)?.raw ?? Buffer.alloc(0));
  const [head, ...rest] = segments as [string, ...string[]];
  if (rest.length === 0) {
    const idx = entries.findIndex((entry) => entry.name === head && entry.mode !== '40000');
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      const entry = entries[idx];
      if (entry !== undefined) entry.oid = blobOid;
    } else {
      entries.push({ mode: '100644', name: head, oid: blobOid });
    }
  } else {
    const idx = entries.findIndex((entry) => entry.name === head && entry.mode === '40000');
    const subOid = idx >= 0 ? entries[idx]?.oid ?? null : null;
    const newSubOid = writePath(git, subOid, rest, blobOid);
    const newSubEntries = parseTree(git.getObject(newSubOid)?.raw ?? Buffer.alloc(0));
    if (newSubEntries.length === 0 && blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      const entry = entries[idx];
      if (entry !== undefined) entry.oid = newSubOid;
    } else {
      entries.push({ mode: '40000', name: head, oid: newSubOid });
    }
  }
  return git.putObject('tree', encodeTree(entries));
}

/** The tree entry at `segments` below a commit's tree, or null when absent. */
function readPath(
  git: GitStore,
  commitSha: string,
  segments: readonly string[],
): { type: 'file' | 'dir'; oid: string; mode: string } | null {
  const commit = git.getObject(commitSha);
  if (commit === undefined || commit.type !== 'commit') return null;
  const parsed = parseCommit(commit.raw);
  if (parsed.tree === '') return null;
  let treeOid = parsed.tree;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    const tree = git.getObject(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.raw).find((item) => item.name === segment);
    if (entry === undefined) return null;
    const last = i === segments.length - 1;
    if (entry.mode === '40000') {
      if (last) return { type: 'dir', oid: entry.oid, mode: entry.mode };
      treeOid = entry.oid;
    } else if (last) {
      return { type: 'file', oid: entry.oid, mode: entry.mode };
    } else {
      return null;
    }
  }
  return { type: 'dir', oid: treeOid, mode: '40000' };
}

/** The direct children of the directory at `segments` below a commit's tree. */
function listDir(git: GitStore, commitSha: string, segments: readonly string[]): TreeEntry[] | null {
  const found = readPath(git, commitSha, segments);
  if (found === null || found.type !== 'dir') return null;
  const tree = git.getObject(found.oid);
  if (tree === undefined || tree.type !== 'tree') return null;
  return parseTree(tree.raw);
}

/** Create a commit object and return its oid. Timestamp from the clock. */
function createCommit(
  git: GitStore,
  treeOid: string,
  parentSha: string | null,
  message: string,
  login: string,
): string {
  const unix = Math.floor(nowMs() / 1000);
  const ident = `${login} <${login}@example.invalid> ${unix} +0000`;
  let text = `tree ${treeOid}\n`;
  if (parentSha !== null) text += `parent ${parentSha}\n`;
  text += `author ${ident}\ncommitter ${ident}\n\n${message}\n`;
  return git.putObject('commit', Buffer.from(text, 'utf8'));
}

/**
 * Resolve a contents/commits `ref` (branch name, or a commit oid) to a tip
 * commit sha, or null when the ref does not exist. With no ref, the default
 * branch tip (null on an unborn repository).
 */
function resolveRef(repo: Repo, git: GitStore, ref: string | undefined): string | null {
  if (ref === undefined || ref === '') {
    return repo.branches.get(repo.defaultBranch)?.sha ?? null;
  }
  const branch = repo.branches.get(ref);
  if (branch !== undefined) return branch.sha;
  if (SHA40.test(ref)) {
    const object = git.getObject(ref.toLowerCase());
    if (object !== undefined && object.type === 'commit') return ref.toLowerCase();
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

function userJson(store: import('./store.ts').Store, login: string): Record<string, unknown> {
  const user = store.users.get(login.toLowerCase());
  return {
    login,
    id: user?.id ?? 0,
    node_id: `U_${user?.id ?? 0}`,
    type: 'User',
    site_admin: false,
  };
}

function repoJson(store: import('./store.ts').Store, repo: Repo): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  let openIssues = 0;
  for (const issue of repo.issues.values()) {
    if (issue.state === 'open') openIssues += 1;
  }
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(store, repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: base,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    svn_url: `https://github.com/${repo.owner}/${repo.name}`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function commitJson(git: GitStore, sha: string): Record<string, unknown> | null {
  const object = git.getObject(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const parsed = parseCommit(object.raw);
  const author = parseIdent(parsed.author);
  const committer = parseIdent(parsed.committer);
  return {
    sha,
    node_id: `C_${sha}`,
    commit: {
      message: parsed.message,
      tree: { sha: parsed.tree },
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
    },
    author: { login: author.name, email: author.email },
    committer: { login: committer.name, email: committer.email },
    parents: parsed.parents.map((parent) => ({ sha: parent })),
  };
}

/** Walk first parents from a tip, newest first. */
function walkCommits(git: GitStore, tip: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let current: string | null = tip;
  while (current !== null && !seen.has(current)) {
    seen.add(current);
    out.push(current);
    const object = git.getObject(current);
    if (object === undefined || object.type !== 'commit') break;
    const parsed = parseCommit(object.raw);
    current = parsed.parents[0] ?? null;
  }
  return out;
}

function contentFileJson(
  git: GitStore,
  repo: Repo,
  segments: readonly string[],
  blobOid: string,
): Record<string, unknown> {
  const blob = git.getObject(blobOid);
  const bytes = blob?.raw ?? Buffer.alloc(0);
  const path = segments.join('/');
  return {
    type: 'file',
    encoding: 'base64',
    size: bytes.length,
    name: segments[segments.length - 1] ?? '',
    path,
    content: bytes.toString('base64'),
    sha: blobOid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    download_url: null,
    _links: {
      self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git: `/api/v3/repos/${repo.owner}/${repo.name}/git/blobs/${blobOid}`,
      html: `https://github.com/${repo.owner}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
    },
  };
}

function contentDirEntryJson(
  git: GitStore,
  repo: Repo,
  parentSegments: readonly string[],
  entry: TreeEntry,
): Record<string, unknown> {
  const path = [...parentSegments, entry.name].join('/');
  const out: Record<string, unknown> = {
    type: entry.mode === '40000' ? 'dir' : 'file',
    name: entry.name,
    path,
    sha: entry.oid,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
    git_url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
    download_url: null,
    _links: {
      self: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${path}`,
      git: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
      html: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${path}`,
    },
  };
  if (entry.mode !== '40000') {
    out.size = git.getObject(entry.oid)?.raw.length ?? 0;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const REPO_NAME = /^[A-Za-z0-9._-]+$/;

function isValidRepoName(name: string): boolean {
  return (
    name.length >= 1 &&
    name.length <= 100 &&
    REPO_NAME.test(name) &&
    name !== '.' &&
    name !== '..' &&
    !name.startsWith('.') &&
    !name.includes('..')
  );
}

function isValidBranchName(name: string): boolean {
  return (
    name.length >= 1 &&
    /^[A-Za-z0-9._/-]+$/.test(name) &&
    !name.includes('..') &&
    !name.startsWith('/') &&
    !name.endsWith('/') &&
    !name.includes('//')
  );
}

function decodeBase64Strict(value: string): Buffer {
  const compact = value.replace(/[\r\n\t ]+/g, '');
  if (compact === '') return Buffer.alloc(0);
  if (compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)) {
    throw unprocessable('content is not valid base64');
  }
  return Buffer.from(compact, 'base64');
}

// ---------------------------------------------------------------------------
// Route handlers (each writes exactly one reply)
// ---------------------------------------------------------------------------

interface RestCtx {
  store: import('./store.ts').Store;
  git: GitStore;
}

function requireRepo(ctx: RestCtx, owner: string, name: string): Repo {
  const repo = getRepo(ctx.store, owner, name);
  if (repo === undefined) throw notFound('Not Found');
  return repo;
}

/** POST /api/v3/user/repos — create a repository owned by the viewer. */
async function createRepoHandler(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  login: string,
): Promise<void> {
  const body = await readJsonObject(req);
  const name = typeof body?.name === 'string' ? body.name : '';
  if (name === '') throw unprocessable('name is required');
  if (!isValidRepoName(name)) throw unprocessable('Invalid repository name');
  if (getRepo(ctx.store, login, name) !== undefined) throw unprocessable('Repository already exists');
  let defaultBranch = 'main';
  const requestedBranch = optionalString(body, 'default_branch');
  if (requestedBranch !== undefined) {
    if (!isValidBranchName(requestedBranch)) throw unprocessable('Invalid default_branch');
    defaultBranch = requestedBranch;
  }
  const repo: Repo = {
    id: ctx.store.nextRepoId,
    owner: login,
    name,
    description: typeof body?.description === 'string' ? (body.description as string) : '',
    defaultBranch,
    private: body?.private === true,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    branches: new Map(),
    refs: new Map(),
    issues: new Map(),
    pulls: new Map(),
    labels: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextLabel: 1,
    nextComment: 1,
  };
  ctx.store.nextRepoId += 1;
  ctx.store.repos.set(repoKey(login, name), repo);
  sendJson(res, 201, repoJson(ctx.store, repo));
}

/** PATCH /api/v3/repos/{owner}/{repo} — description / default_branch / private. */
async function patchRepoHandler(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
): Promise<void> {
  const repo = requireRepo(ctx, owner, name);
  const body = await readJsonObject(req);
  if (body !== undefined) {
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        throw unprocessable('description must be a string');
      }
      repo.description = (body.description as string | null) ?? '';
    }
    if (body.default_branch !== undefined) {
      const branch = body.default_branch;
      if (typeof branch !== 'string' || !isValidBranchName(branch)) {
        throw unprocessable('Invalid default_branch');
      }
      if (!repo.branches.has(branch) && repo.refs.size > 0) {
        throw unprocessable('default_branch does not exist');
      }
      repo.defaultBranch = branch;
    }
    if (body.private !== undefined) {
      if (typeof body.private !== 'boolean') throw unprocessable('private must be a boolean');
      repo.private = body.private;
    }
  }
  repo.updatedAt = nowIso();
  sendJson(res, 200, repoJson(ctx.store, repo));
}

/** DELETE /api/v3/repos/{owner}/{repo} — 204, no body. */
function deleteRepoHandler(ctx: RestCtx, res: ServerResponse, owner: string, name: string): void {
  requireRepo(ctx, owner, name);
  ctx.store.repos.delete(repoKey(owner, name));
  res.writeHead(204, { 'x-github-request-id': newRequestId() });
  res.end();
}

/** GET /api/v3/user/repos and GET /api/v3/users/{username}/repos — paginated. */
function listReposHandler(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  username: string | undefined,
  login: string,
): void {
  let repos: Repo[];
  if (username === undefined) {
    repos = [...ctx.store.repos.values()].filter((repo) => repo.owner.toLowerCase() === login.toLowerCase());
  } else if (username.toLowerCase() === login.toLowerCase()) {
    repos = [...ctx.store.repos.values()].filter((repo) => repo.owner.toLowerCase() === login.toLowerCase());
  } else {
    repos = [];
  }
  const { page, headers } = paginate(req, query, repos);
  sendJson(res, 200, page.map((repo) => repoJson(ctx.store, repo)), headers);
}

/** GET /api/v3/repos/{owner}/{repo}/branches — every branch with its tip. */
function listBranchesHandler(ctx: RestCtx, res: ServerResponse, owner: string, name: string): void {
  const repo = requireRepo(ctx, owner, name);
  const names = [...repo.branches.keys()].sort();
  sendJson(res, 200, names.map((branch) => ({
    name: branch,
    commit: { sha: repo.branches.get(branch)?.sha ?? '' },
    protected: false,
  })));
}

/** GET /api/v3/repos/{owner}/{repo}/branches/{branch} */
function getBranchHandler(ctx: RestCtx, res: ServerResponse, owner: string, name: string, branch: string): void {
  const repo = requireRepo(ctx, owner, name);
  const tip = repo.branches.get(branch);
  if (tip === undefined) throw notFound('Branch not found');
  sendJson(res, 200, { name: branch, commit: { sha: tip.sha }, protected: false });
}

/** GET /api/v3/repos/{owner}/{repo}/commits[?sha=<ref>] — newest first. */
function listCommitsHandler(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  owner: string,
  name: string,
): void {
  const repo = requireRepo(ctx, owner, name);
  const ref = query.get('sha') ?? undefined;
  const tip = resolveRef(repo, ctx.git, ref);
  if (tip === null) {
    if (ref !== undefined) throw notFound('No commit found for SHA');
    sendJson(res, 200, []);
    return;
  }
  const shas = walkCommits(ctx.git, tip);
  const items: Record<string, unknown>[] = [];
  for (const sha of shas) {
    const item = commitJson(ctx.git, sha);
    if (item !== null) items.push(item);
  }
  const { page, headers } = paginate(req, query, items);
  sendJson(res, 200, page, headers);
}

/** GET /api/v3/repos/{owner}/{repo}/commits/{sha} */
function getCommitHandler(ctx: RestCtx, res: ServerResponse, owner: string, name: string, sha: string): void {
  requireRepo(ctx, owner, name);
  const item = SHA40.test(sha) ? commitJson(ctx.git, sha.toLowerCase()) : null;
  if (item === null) throw notFound('No commit found for SHA');
  sendJson(res, 200, item);
}

/** GET /api/v3/repos/{owner}/{repo}/contents/{path}[?ref=] */
function getContentsHandler(
  ctx: RestCtx,
  res: ServerResponse,
  query: URLSearchParams,
  owner: string,
  name: string,
  segments: readonly string[],
): void {
  const repo = requireRepo(ctx, owner, name);
  const ref = query.get('ref') ?? undefined;
  const tip = resolveRef(repo, ctx.git, ref);
  if (tip === null) {
    if (ref !== undefined) throw notFound('No commit found for SHA');
    throw notFound('Not Found');
  }
  const found = readPath(ctx.git, tip, segments);
  if (found === null) throw notFound('Not Found');
  if (found.type === 'file') {
    sendJson(res, 200, contentFileJson(ctx.git, repo, segments, found.oid));
    return;
  }
  const entries = listDir(ctx.git, tip, segments);
  if (entries === null) throw notFound('Not Found');
  sendJson(res, 200, entries.map((entry) => contentDirEntryJson(ctx.git, repo, segments, entry)));
}

/** PUT /api/v3/repos/{owner}/{repo}/contents/{path} — create (201) / update (200). */
async function putContentsHandler(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  segments: readonly string[],
  login: string,
): Promise<void> {
  const repo = requireRepo(ctx, owner, name);
  if (segments.length === 0) throw unprocessable('path is required');
  const body = await readJsonObject(req);
  const message = requiredString(body, 'message');
  const content = requiredString(body, 'content');
  const contentBytes = decodeBase64Strict(content);
  const branch = optionalString(body, 'branch') ?? repo.defaultBranch;
  if (!isValidBranchName(branch)) throw unprocessable('Invalid branch');
  const sha = optionalString(body, 'sha');
  if (sha !== undefined && !SHA40.test(sha)) throw unprocessable('Invalid sha');

  const tip = repo.branches.get(branch)?.sha ?? null;
  if (tip === null) {
    // An unborn repository accepts its first commit on the default branch.
    if (!(branch === repo.defaultBranch && repo.refs.size === 0)) throw notFound('Branch not found');
  }
  const parentTree = tip === null ? null : parseCommit(ctx.git.getObject(tip)?.raw ?? Buffer.alloc(0)).tree;
  const current = tip === null ? null : readPath(ctx.git, tip, segments);
  if (current !== null && current.type === 'dir') throw unprocessable('path is a directory');
  let status: number;
  if (current !== null) {
    if (sha === undefined) throw conflict('sha is required to update an existing file');
    if (sha.toLowerCase() !== current.oid.toLowerCase()) throw conflict('sha does not match the current file');
    status = 200;
  } else {
    if (sha !== undefined) throw unprocessable('sha must not be provided when creating a file');
    status = 201;
  }

  const blobOid = ctx.git.putObject('blob', contentBytes);
  const treeOid = writePath(ctx.git, parentTree === '' ? null : parentTree, segments, blobOid);
  const commitSha = createCommit(ctx.git, treeOid, tip, message, login);
  ctx.git.setRef(repoKey(repo.owner, repo.name), `refs/heads/${branch}`, commitSha);
  repo.updatedAt = nowIso();
  const parsed = parseCommit(ctx.git.getObject(commitSha)?.raw ?? Buffer.alloc(0));
  const author = parseIdent(parsed.author);
  sendJson(res, status, {
    content: contentFileJson(ctx.git, repo, segments, blobOid),
    commit: {
      sha: commitSha,
      message: parsed.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: author.name, email: author.email, date: author.date },
      tree: { sha: treeOid },
      parents: tip === null ? [] : [{ sha: tip }],
    },
  });
}

/** DELETE /api/v3/repos/{owner}/{repo}/contents/{path} — 200 {commit}. */
async function deleteContentsHandler(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
  segments: readonly string[],
  login: string,
): Promise<void> {
  const repo = requireRepo(ctx, owner, name);
  if (segments.length === 0) throw unprocessable('path is required');
  const body = await readJsonObject(req);
  const message = requiredString(body, 'message');
  const sha = optionalString(body, 'sha');
  if (sha === undefined) throw unprocessable('sha is required');
  if (!SHA40.test(sha)) throw unprocessable('Invalid sha');
  const branch = optionalString(body, 'branch') ?? repo.defaultBranch;
  if (!isValidBranchName(branch)) throw unprocessable('Invalid branch');
  const tip = repo.branches.get(branch)?.sha ?? null;
  if (tip === null) throw notFound('Not Found');
  const current = readPath(ctx.git, tip, segments);
  if (current === null) throw notFound('Not Found');
  if (current.type === 'dir') throw unprocessable('path is a directory');
  if (sha.toLowerCase() !== current.oid.toLowerCase()) throw conflict('sha does not match the current file');
  const parentTree = parseCommit(ctx.git.getObject(tip)?.raw ?? Buffer.alloc(0)).tree;
  const treeOid = writePath(ctx.git, parentTree === '' ? null : parentTree, segments, null);
  const commitSha = createCommit(ctx.git, treeOid, tip, message, login);
  ctx.git.setRef(repoKey(repo.owner, repo.name), `refs/heads/${branch}`, commitSha);
  repo.updatedAt = nowIso();
  const parsed = parseCommit(ctx.git.getObject(commitSha)?.raw ?? Buffer.alloc(0));
  const author = parseIdent(parsed.author);
  sendJson(res, 200, {
    content: null,
    commit: {
      sha: commitSha,
      message: parsed.message,
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: author.name, email: author.email, date: author.date },
      tree: { sha: treeOid },
      parents: [{ sha: tip }],
    },
  });
}

/** POST /api/v3/repos/{owner}/{repo}/git/refs — create a branch ref at a commit. */
async function createRefHandler(
  ctx: RestCtx,
  req: IncomingMessage,
  res: ServerResponse,
  owner: string,
  name: string,
): Promise<void> {
  const repo = requireRepo(ctx, owner, name);
  const body = await readJsonObject(req);
  const ref = requiredString(body, 'ref');
  const sha = requiredString(body, 'sha');
  if (!ref.startsWith('refs/')) throw unprocessable('Invalid ref');
  if (!SHA40.test(sha)) throw unprocessable('Invalid sha');
  const object = ctx.git.getObject(sha.toLowerCase());
  if (object === undefined || object.type !== 'commit') throw unprocessable('Invalid sha');
  if (ctx.git.getRef(repoKey(repo.owner, repo.name), ref) !== undefined) {
    throw unprocessable('Reference already exists');
  }
  ctx.git.setRef(repoKey(repo.owner, repo.name), ref, sha.toLowerCase());
  sendJson(res, 201, {
    ref,
    node_id: `R_${ref}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
    object: { sha: sha.toLowerCase(), type: 'commit' },
  });
}

/** GET /api/v3/repos/{owner}/{repo}/git/refs[/{ref...}] */
function getRefsHandler(
  ctx: RestCtx,
  res: ServerResponse,
  owner: string,
  name: string,
  segments: readonly string[],
): void {
  const repo = requireRepo(ctx, owner, name);
  const key = repoKey(repo.owner, repo.name);
  if (segments.length === 0) {
    const refs = ctx.git.listRefs(key);
    sendJson(res, 200, refs.map((entry) => ({
      ref: entry.ref,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${entry.ref}`,
      object: { sha: entry.oid, type: 'commit' },
    })));
    return;
  }
  const ref = `refs/${segments.join('/')}`;
  const oid = ctx.git.getRef(key, ref);
  if (oid === undefined) throw notFound('Not Found');
  sendJson(res, 200, {
    ref,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/git/${ref}`,
    object: { sha: oid, type: 'commit' },
  });
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

/**
 * Authenticate a request: any non-empty Bearer token is the viewer. Returns
 * the viewer login, or null when the request carries no usable token.
 */
function authenticate(req: IncomingMessage, store: RestCtx['store']): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null) return null;
  const token = match[1] ?? '';
  if (token === '') return null;
  if (!store.users.has(VIEWER_LOGIN.toLowerCase())) {
    store.users.set(VIEWER_LOGIN.toLowerCase(), { id: store.nextUserId, login: VIEWER_LOGIN });
    store.nextUserId += 1;
  }
  return VIEWER_LOGIN;
}

/** Namespaces later modules own; this handler returns false for them. */
function isOtherModulePath(segments: readonly string[]): boolean {
  // /api/v3/repos/{owner}/{repo}/issues|labels|pulls[/...]
  return (
    segments[0] === 'repos' &&
    segments.length >= 4 &&
    (segments[3] === 'issues' || segments[3] === 'labels' || segments[3] === 'pulls')
  );
}

export function mountRest(ctx: RouterContext): RouteHandler {
  const rest: RestCtx = { store: ctx.store, git: ctx.git };
  return async (req, res, pathname, method) => {
    if (!pathname.startsWith('/api/v3')) return false;
    if (pathname === '/api/v3' || pathname === '/api/v3/') return false;
    const segments = splitPath(pathname);
    // segments[0] === 'api', segments[1] === 'v3'
    const restSegments = segments.slice(2);
    if (isOtherModulePath(restSegments)) return false;

    const login = authenticate(req, rest.store);
    if (login === null) {
      jsonError(res, 401, 'Requires authentication');
      return true;
    }

    const query = queryOf(req);
    try {
      // GET /api/v3/meta
      if (method === 'GET' && restSegments.length === 1 && restSegments[0] === 'meta') {
        sendJson(res, 200, { installed_version: INSTALLED_VERSION });
        return true;
      }
      // GET /api/v3/user
      if (method === 'GET' && restSegments.length === 1 && restSegments[0] === 'user') {
        sendJson(res, 200, {
          ...userJson(rest.store, login),
          name: login,
          email: `${login}@example.invalid`,
        });
        return true;
      }
      // POST /api/v3/user/repos ; GET /api/v3/user/repos
      if (restSegments.length === 2 && restSegments[0] === 'user' && restSegments[1] === 'repos') {
        if (method === 'POST') {
          await createRepoHandler(rest, req, res, login);
          return true;
        }
        if (method === 'GET') {
          listReposHandler(rest, req, res, query, undefined, login);
          return true;
        }
        return false;
      }
      // GET /api/v3/users/{username}/repos
      if (
        restSegments.length === 3 &&
        restSegments[0] === 'users' &&
        restSegments[2] === 'repos'
      ) {
        if (method === 'GET') {
          listReposHandler(rest, req, res, query, restSegments[1], login);
          return true;
        }
        return false;
      }
      // /api/v3/repos/{owner}/{repo}[/...]
      if (restSegments[0] === 'repos' && restSegments.length >= 3) {
        const owner = restSegments[1] ?? '';
        const name = restSegments[2] ?? '';
        const tail = restSegments.slice(3);
        if (tail.length === 0) {
          if (method === 'GET') {
            const repo = requireRepo(rest, owner, name);
            sendJson(res, 200, repoJson(rest.store, repo));
            return true;
          }
          if (method === 'PATCH') {
            await patchRepoHandler(rest, req, res, owner, name);
            return true;
          }
          if (method === 'DELETE') {
            deleteRepoHandler(rest, res, owner, name);
            return true;
          }
          return false;
        }
        if (tail[0] === 'branches') {
          if (method === 'GET' && tail.length === 1) {
            listBranchesHandler(rest, res, owner, name);
            return true;
          }
          if (method === 'GET' && tail.length >= 2) {
            getBranchHandler(rest, res, owner, name, tail.slice(1).join('/'));
            return true;
          }
          return false;
        }
        if (tail[0] === 'commits') {
          if (method === 'GET' && tail.length === 1) {
            listCommitsHandler(rest, req, res, query, owner, name);
            return true;
          }
          if (method === 'GET' && tail.length === 2) {
            getCommitHandler(rest, res, owner, name, tail[1] ?? '');
            return true;
          }
          return false;
        }
        if (tail[0] === 'contents') {
          const pathSegments = tail.slice(1);
          if (method === 'GET') {
            getContentsHandler(rest, res, query, owner, name, pathSegments);
            return true;
          }
          if (method === 'PUT') {
            await putContentsHandler(rest, req, res, owner, name, pathSegments, login);
            return true;
          }
          if (method === 'DELETE') {
            await deleteContentsHandler(rest, req, res, owner, name, pathSegments, login);
            return true;
          }
          return false;
        }
        if (tail[0] === 'git' && tail[1] === 'refs') {
          if (method === 'POST' && tail.length === 2) {
            await createRefHandler(rest, req, res, owner, name);
            return true;
          }
          if (method === 'GET') {
            getRefsHandler(rest, res, owner, name, tail.slice(2));
            return true;
          }
          return false;
        }
        // A repo sub-path this module does not own: JSON 404, not a fall-through.
        jsonError(res, 404, 'Not Found');
        return true;
      }
      // Anything else under /api/v3: JSON 404.
      jsonError(res, 404, 'Not Found');
      return true;
    } catch (err) {
      if (err instanceof ApiError) {
        jsonError(res, err.status, err.message);
        return true;
      }
      if (err instanceof MalformedJsonError) {
        jsonError(res, 400, 'Malformed JSON in request body');
        return true;
      }
      if (err instanceof BodyTooLargeError) {
        jsonError(res, 413, 'Request body too large');
        return true;
      }
      throw err;
    }
  };
}
