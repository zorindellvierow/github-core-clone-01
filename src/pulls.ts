// Pull requests (M2): POST/GET /pulls, GET /pulls/{n}/files and
// PUT /pulls/{n}/merge (squash). Mounted by app.ts after mountRest and
// mountIssues; claims every /api/v3/repos/{owner}/{repo}/pulls[/...] path.
//
// Merge is a squash onto the pull's base branch: one new commit whose tree
// is the head tree, whose single parent is the current base tip, and whose
// message is "<title> (#n)". The pull then reports state "closed" (the
// checks' pull shape only admits open/closed), merged=true, merged_at and
// merge_commit_sha equal to the squash commit.
//
// Conflict detection is a three-way check against the merge-base: a path
// counts as conflicted when the base side changed it since the merge-base
// AND the head side changed it differently since the merge-base (including
// delete-vs-modify). A conflicted merge is a 405 and the pull stays open.
// An already-merged pull is a 409; an unknown pull is a 404.
//
// Diffs come from the real git objects (flattened trees, line-counted
// changes), never from stored guesses: GET /pulls/{n}/files diffs the
// merge-base tree against the current head tip.
//
// Same auth / error / pagination contract as M1/M2-issues (helpers imported
// from ./issues.ts); timestamps from src/clock.ts; no Date.now() /
// Math.random() in request code. All state lives in the Store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { nowIso, nowMs } from './clock.ts';
import {
  ApiError,
  conflict,
  notFound,
  optionalString,
  paginate,
  queryOf,
  readJsonObject,
  requireRepo,
  splitPath,
  unprocessable,
  userJson,
  type IssuesCtx,
} from './issues.ts';
import { authViewer } from './rest.ts';
import type { RouteHandler, RouterContext } from './router.ts';
import type { GitStore, Pull, Repo } from './store.ts';
import {
  BodyTooLargeError,
  MalformedJsonError,
  jsonError,
  sendJson,
} from './util.ts';

// ---------------------------------------------------------------------------
// Git object reading: trees, commits, ancestry
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

interface ParsedCommit {
  tree: string;
  parents: string[];
  message: string;
}

/** Parse a raw commit object (tree / parents / message only). */
function parseCommit(raw: Buffer): ParsedCommit {
  const text = raw.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = (split === -1 ? '' : text.slice(split + 2)).replace(/\n+$/, '');
  const out: ParsedCommit = { tree: '', parents: [], message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
  }
  return out;
}

function readCommit(git: GitStore, sha: string): ParsedCommit | null {
  const object = git.getObject(sha);
  if (object === undefined || object.type !== 'commit') return null;
  return parseCommit(object.raw);
}

/** Flatten a tree into path -> blob oid (recursing into subtrees). */
function flattenTree(git: GitStore, treeOid: string, prefix: string, out: Map<string, string>): void {
  const object = git.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  for (const entry of parseTree(object.raw)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(git, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
}

/** path -> blob oid for the tree of a commit, or an empty map when unreadable. */
function treeOfCommit(git: GitStore, sha: string): Map<string, string> {
  const out = new Map<string, string>();
  const commit = readCommit(git, sha);
  if (commit === null || commit.tree === '') return out;
  flattenTree(git, commit.tree, '', out);
  return out;
}

/** Every commit reachable from `sha` (parents first, breadth-first). */
function ancestors(git: GitStore, sha: string): Set<string> {
  const seen = new Set<string>();
  const queue = [sha];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    const commit = readCommit(git, current);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

/** A merge-base of two commits: the first head-side ancestor also reachable from base. */
function mergeBase(git: GitStore, headSha: string, baseSha: string): string | null {
  const baseAncestors = ancestors(git, baseSha);
  const seen = new Set<string>();
  const queue = [headSha];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || seen.has(current)) continue;
    seen.add(current);
    if (baseAncestors.has(current)) return current;
    const commit = readCommit(git, current);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** Line counts of a blob (empty blob -> 0 lines; trailing newline adds none). */
function blobLines(git: GitStore, oid: string): string[] {
  const object = git.getObject(oid);
  if (object === undefined) return [];
  const text = object.raw.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Multiset line diff: [added lines, removed lines] between two blobs. */
function countLineChanges(git: GitStore, oldOid: string | null, newOid: string | null): { additions: number; deletions: number } {
  const oldLines = oldOid === null ? [] : blobLines(git, oldOid);
  const newLines = newOid === null ? [] : blobLines(git, newOid);
  const counts = new Map<string, number>();
  for (const line of oldLines) counts.set(line, (counts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of newLines) {
    const remaining = counts.get(line) ?? 0;
    if (remaining > 0) counts.set(line, remaining - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const remaining of counts.values()) deletions += remaining;
  return { additions, deletions };
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two flattened trees (base -> head), sorted by path. */
function diffTrees(base: Map<string, string>, head: Map<string, string>): FileChange[] {
  const out: FileChange[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = base.get(path) ?? null;
    const newOid = head.get(path) ?? null;
    if (oldOid === newOid) continue;
    if (oldOid === null) out.push({ path, status: 'added', oldOid, newOid });
    else if (newOid === null) out.push({ path, status: 'removed', oldOid, newOid });
    else out.push({ path, status: 'modified', oldOid, newOid });
  }
  return out;
}

/**
 * The three-way conflict test for a merge: for every path, compare the
 * merge-base version against the current base tip and the head tip. A path
 * is conflicted when both sides changed it since the merge-base and changed
 * it differently.
 */
function findConflict(git: GitStore, baseSha: string, headSha: string): string | null {
  const base = mergeBase(git, headSha, baseSha);
  const baseMap = base === null ? new Map<string, string>() : treeOfCommit(git, base);
  const currentMap = treeOfCommit(git, baseSha);
  const headMap = treeOfCommit(git, headSha);
  const paths = new Set([...baseMap.keys(), ...currentMap.keys(), ...headMap.keys()]);
  for (const path of paths) {
    const ancestor = baseMap.get(path) ?? null;
    const current = currentMap.get(path) ?? null;
    const head = headMap.get(path) ?? null;
    const baseChanged = current !== ancestor;
    const headChanged = head !== ancestor;
    if (baseChanged && headChanged && current !== head) return path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Serializers
// ---------------------------------------------------------------------------

/** The pull's live head/base tips: the branch tip when the branch still exists. */
function liveTips(ctx: IssuesCtx, repo: Repo, pull: Pull): { headSha: string; baseSha: string } {
  const headSha = repo.branches.get(pull.head.ref)?.sha ?? pull.head.sha;
  const baseSha = repo.branches.get(pull.base.ref)?.sha ?? pull.base.sha;
  return { headSha, baseSha };
}

function pullJson(ctx: IssuesCtx, repo: Repo, pull: Pull): Record<string, unknown> {
  const { headSha, baseSha } = liveTips(ctx, repo, pull);
  const merged = pull.state === 'merged';
  const closed = pull.state === 'closed' || merged;
  // Mergeable is computed live for open pulls; merged/closed pulls report false.
  let mergeable = false;
  if (pull.state === 'open') {
    const base = mergeBase(ctx.git, headSha, baseSha);
    const baseMap = base === null ? new Map<string, string>() : treeOfCommit(ctx.git, base);
    const currentMap = treeOfCommit(ctx.git, baseSha);
    const headMap = treeOfCommit(ctx.git, headSha);
    const hasDiff = diffTrees(baseMap, headMap).length > 0;
    mergeable = hasDiff && findConflict(ctx.git, baseSha, headSha) === null;
  }
  const baseUrl = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    url: `${baseUrl}/pulls/${pull.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: closed ? 'closed' : 'open',
    locked: false,
    user: userJson(ctx.store, pull.user),
    labels: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: closed ? pull.updatedAt : null,
    merged_at: merged ? pull.updatedAt : null,
    merged: merged,
    mergeable,
    merge_commit_sha: pull.mergeCommitSha,
    head: {
      ref: pull.head.ref,
      sha: headSha,
      label: `${repo.owner}:${pull.head.ref}`,
      user: userJson(ctx.store, repo.owner),
    },
    base: {
      ref: pull.base.ref,
      sha: baseSha,
      label: `${repo.owner}:${pull.base.ref}`,
      user: userJson(ctx.store, repo.owner),
    },
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function requirePull(repo: Repo, numberRaw: string): Pull {
  const number = Number.parseInt(numberRaw, 10);
  if (!Number.isInteger(number) || number < 1) throw notFound('Not Found');
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw notFound('Not Found');
  return pull;
}

async function createPullHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  login: string,
): Promise<void> {
  const body = await readJsonObject(req);
  const title = body?.title;
  if (typeof title !== 'string' || title === '') throw unprocessable('title is required');
  const headRef = body?.head;
  if (typeof headRef !== 'string' || headRef === '') throw unprocessable('head is required');
  const baseRef = body?.base;
  if (typeof baseRef !== 'string' || baseRef === '') throw unprocessable('base is required');
  const pullBody = optionalString(body, 'body') ?? '';
  const headSha = repo.branches.get(headRef)?.sha;
  if (headSha === undefined) throw unprocessable(`head branch does not exist: ${headRef}`);
  const baseSha = repo.branches.get(baseRef)?.sha;
  if (baseSha === undefined) throw unprocessable(`base branch does not exist: ${baseRef}`);
  if (headRef === baseRef) throw unprocessable('head and base must be different branches');
  const base = mergeBase(ctx.git, headSha, baseSha);
  const baseMap = base === null ? new Map<string, string>() : treeOfCommit(ctx.git, base);
  const headMap = treeOfCommit(ctx.git, headSha);
  const changes = diffTrees(baseMap, headMap);
  if (changes.length === 0) throw unprocessable('head and base have no differences');
  const number = repo.nextPull;
  repo.nextPull += 1;
  const stamp = nowIso();
  const pull: Pull = {
    id: number,
    number,
    title,
    body: pullBody,
    state: 'open',
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    merged: false,
    mergeCommitSha: null,
    changedPaths: changes.map((change) => change.path),
    user: login,
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.pulls.set(number, pull);
  sendJson(res, 201, pullJson(ctx, repo, pull));
}

function listPullsHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  repo: Repo,
): void {
  const state = query.get('state') ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') throw unprocessable('Invalid state');
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed' || pull.state === 'merged');
  pulls.sort((a, b) => b.number - a.number);
  const { page, headers } = paginate(req, query, pulls);
  sendJson(res, 200, page.map((pull) => pullJson(ctx, repo, pull)), headers);
}

function listPullFilesHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  repo: Repo,
  pull: Pull,
): void {
  const { headSha, baseSha } = liveTips(ctx, repo, pull);
  const base = mergeBase(ctx.git, headSha, baseSha);
  const baseMap = base === null ? new Map<string, string>() : treeOfCommit(ctx.git, base);
  const headMap = treeOfCommit(ctx.git, headSha);
  const changes = diffTrees(baseMap, headMap);
  const items = changes.map((change) => {
    const { additions, deletions } = countLineChanges(ctx.git, change.oldOid, change.newOid);
    return {
      sha: change.newOid ?? change.oldOid ?? '',
      filename: change.path,
      status: change.status === 'modified' ? 'modified' : change.status,
      additions,
      deletions,
      changes: additions + deletions,
    };
  });
  const { page, headers } = paginate(req, query, items);
  sendJson(res, 200, page, headers);
}

/** Create the squash commit for a merge and move the base branch to it. */
function squashMerge(ctx: IssuesCtx, repo: Repo, pull: Pull, login: string): string {
  const { headSha, baseSha } = liveTips(ctx, repo, pull);
  const headCommit = readCommit(ctx.git, headSha);
  const treeOid = headCommit?.tree ?? '';
  if (treeOid === '') throw new ApiError(500, 'head commit has no tree');
  const unix = Math.floor(nowMs() / 1000);
  const ident = `${login} <${login}@example.invalid> ${unix} +0000`;
  const message = `${pull.title} (#${pull.number})`;
  const text = `tree ${treeOid}\nparent ${baseSha}\nauthor ${ident}\ncommitter ${ident}\n\n${message}\n`;
  const sha = ctx.git.putObject('commit', Buffer.from(text, 'utf8'));
  const key = `${repo.owner}/${repo.name}`.toLowerCase();
  ctx.git.setRef(key, `refs/heads/${pull.base.ref}`, sha);
  repo.updatedAt = nowIso();
  return sha;
}

async function mergePullHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  pull: Pull,
  login: string,
): Promise<void> {
  // The merge body is optional; a malformed body is still a 400.
  await readJsonObject(req);
  if (pull.state === 'merged') throw conflict('Pull request already merged');
  if (pull.state === 'closed') throw new ApiError(405, 'Pull request is closed');
  const { headSha, baseSha } = liveTips(ctx, repo, pull);
  if (headSha === baseSha) throw new ApiError(405, 'Nothing to merge');
  const conflictPath = findConflict(ctx.git, baseSha, headSha);
  if (conflictPath !== null) {
    throw new ApiError(405, `Merge conflict in ${conflictPath}`);
  }
  const base = mergeBase(ctx.git, headSha, baseSha);
  const baseMap = base === null ? new Map<string, string>() : treeOfCommit(ctx.git, base);
  const headMap = treeOfCommit(ctx.git, headSha);
  if (diffTrees(baseMap, headMap).length === 0) {
    throw new ApiError(405, 'Nothing to merge');
  }
  const sha = squashMerge(ctx, repo, pull, login);
  pull.state = 'merged';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  sendJson(res, 200, {
    merged: true,
    sha,
    message: `${pull.title} (#${pull.number})`,
  });
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountPulls(ctx: RouterContext): RouteHandler {
  const pctx: IssuesCtx = { store: ctx.store, git: ctx.git };
  return async (req, res, pathname, method) => {
    if (!pathname.startsWith('/api/v3/repos/')) return false;
    const segments = splitPath(pathname);
    if (segments.length < 6 || segments[2] !== 'repos') return false;
    const tail = segments.slice(5);
    if (tail[0] !== 'pulls') return false;

    const login = authViewer(req, pctx.store);
    if (login === null) {
      jsonError(res, 401, 'Requires authentication');
      return true;
    }

    const owner = segments[3] ?? '';
    const name = segments[4] ?? '';
    const query = queryOf(req);
    try {
      const repo = requireRepo(pctx, owner, name, login);

      if (tail.length === 1) {
        if (method === 'POST') {
          await createPullHandler(pctx, req, res, repo, login);
          return true;
        }
        if (method === 'GET') {
          listPullsHandler(pctx, req, res, query, repo);
          return true;
        }
        return false;
      }
      const pull = requirePull(repo, tail[1] ?? '');
      if (tail.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, pullJson(pctx, repo, pull));
          return true;
        }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'files') {
        if (method === 'GET') {
          listPullFilesHandler(pctx, req, res, query, repo, pull);
          return true;
        }
        return false;
      }
      if (tail.length === 3 && tail[2] === 'merge') {
        if (method === 'PUT') {
          await mergePullHandler(pctx, req, res, repo, pull, login);
          return true;
        }
        return false;
      }
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
