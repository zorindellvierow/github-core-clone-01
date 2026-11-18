// MCP (M5): JSON-RPC 2.0 Streamable HTTP at POST /mcp.
//
// Speaks both protocol eras the suite accepts:
//   - modern 2026-07-28: `server/discover` (no handshake, no session);
//   - legacy 2025-11-25 and earlier: `initialize` + `notifications/initialized`.
// Every request is answered with one plain JSON body (the client also
// accepts SSE, but plain JSON is enough). JSON-RPC errors keep HTTP 200,
// except a malformed body (HTTP 400, -32700) and a missing token (401).
//
// Tools run on the same Store as REST (same Repo/Issue/Pull records, same
// ids), so MCP and REST read back the same objects. All tool work is
// synchronous on the Store, so concurrent calls cannot interleave mid-mutation.
//
// No Date.now()/Math.random() in request code: timestamps from clock.ts.
// All replies via sendJson/jsonError (non-empty X-GitHub-Request-Id).

import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { nowIso, nowMs } from './clock.ts';
import { issueJson, userJson, type IssuesCtx } from './issues.ts';
import { authViewer } from './rest.ts';
import type { RouteHandler, RouterContext } from './router.ts';
import type { GitStore, Issue, Pull, Repo, Store } from './store.ts';
import { getRepo, repoKey } from './store.ts';
import { jsonError, newRequestId, readBody, sendJson } from './util.ts';

// ---------------------------------------------------------------------------
// Protocol constants
// ---------------------------------------------------------------------------

const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

/** Revisions this server speaks, newest first. */
const SUPPORTED_VERSIONS: readonly string[] = [
  '2026-07-28',
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
];
const PREFERRED_VERSION = SUPPORTED_VERSIONS[0] ?? '2026-07-28';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_VERSION = -32022;

type JsonRpcId = string | number | null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// tools/list: one fixed literal array (byte-for-byte deterministic)
// ---------------------------------------------------------------------------

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
        head: { type: 'string', description: 'The head branch (the branch with the changes).' },
        base: { type: 'string', description: 'The base branch (the branch the changes go into).' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------------------
// Serializers (MCP's own, over the same records REST serializes)
// ---------------------------------------------------------------------------

function repoJsonMcp(store: Store, repo: Repo): Record<string, unknown> {
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
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://github.com/${repo.owner}/${repo.name}.git`,
    ssh_url: `git@github.com:${repo.owner}/${repo.name}.git`,
    clone_url: `https://github.com/${repo.owner}/${repo.name}.git`,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    forks_count: 0,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    visibility: repo.private ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function pullJsonMcp(ctx: IssuesCtx, repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.branches.get(pull.head.ref)?.sha ?? pull.head.sha;
  const baseSha = repo.branches.get(pull.base.ref)?.sha ?? pull.base.sha;
  const merged = pull.state === 'merged';
  const closed = pull.state === 'closed' || merged;
  return {
    id: pull.id,
    node_id: `P_${pull.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
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
    merged,
    mergeable: false,
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
// Git object reading (same algorithms as pulls.ts, over the same GitStore)
// ---------------------------------------------------------------------------

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

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

function flattenTree(git: GitStore, treeOid: string, prefix: string, out: Map<string, string>): void {
  const object = git.getObject(treeOid);
  if (object === undefined || object.type !== 'tree') return;
  for (const entry of parseTree(object.raw)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(git, entry.oid, path, out);
    else out.set(path, entry.oid);
  }
}

function treeOfCommit(git: GitStore, sha: string): Map<string, string> {
  const out = new Map<string, string>();
  const commit = readCommit(git, sha);
  if (commit === null || commit.tree === '') return out;
  flattenTree(git, commit.tree, '', out);
  return out;
}

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

function diffTrees(base: Map<string, string>, head: Map<string, string>): string[] {
  const out: string[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    if (base.get(path) !== head.get(path)) out.push(path);
  }
  return out;
}

/** A path both sides changed differently since the merge-base, or null. */
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
    if (current !== ancestor && head !== ancestor && current !== head) return path;
  }
  return null;
}

function liveTips(repo: Repo, pull: Pull): { headSha: string; baseSha: string } {
  return {
    headSha: repo.branches.get(pull.head.ref)?.sha ?? pull.head.sha,
    baseSha: repo.branches.get(pull.base.ref)?.sha ?? pull.base.sha,
  };
}

/** The squash commit for a merge; moves the base branch to it. */
function squashMerge(ctx: IssuesCtx, repo: Repo, pull: Pull, login: string): string {
  const { headSha, baseSha } = liveTips(repo, pull);
  const headCommit = readCommit(ctx.git, headSha);
  const treeOid = headCommit?.tree ?? '';
  if (treeOid === '') throw new Error('head commit has no tree');
  const unix = Math.floor(nowMs() / 1000);
  const ident = `${login} <${login}@example.invalid> ${unix} +0000`;
  const message = `${pull.title} (#${pull.number})`;
  const text = `tree ${treeOid}\nparent ${baseSha}\nauthor ${ident}\ncommitter ${ident}\n\n${message}\n`;
  const sha = ctx.git.putObject('commit', Buffer.from(text, 'utf8'));
  ctx.git.setRef(repoKey(repo.owner, repo.name), `refs/heads/${pull.base.ref}`, sha);
  repo.updatedAt = nowIso();
  return sha;
}

// ---------------------------------------------------------------------------
// Tool errors (a tool failure: isError:true, never a throw past the handler)
// ---------------------------------------------------------------------------

class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

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

function requiredArg(args: Record<string, unknown>, field: string): unknown {
  const value = args[field];
  if (value === undefined || value === null) throw new ToolError(`${field} is required`);
  return value;
}

function requiredStringArg(args: Record<string, unknown>, field: string): string {
  const value = requiredArg(args, field);
  if (typeof value !== 'string' || value === '') throw new ToolError(`${field} is required`);
  return value;
}

function optionalStringArg(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new ToolError(`${field} must be a string`);
  return value;
}

function pullNumberArg(args: Record<string, unknown>, field: string): number {
  const value = requiredArg(args, field);
  if (typeof value === 'number' && Number.isInteger(value) && value >= 1) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  throw new ToolError(`${field} must be a pull request number`);
}

/** The repo at {owner}/{name} owned by the viewer, else a tool error. */
function requireRepoFor(ctx: IssuesCtx, owner: string, name: string, login: string): Repo {
  const repo = getRepo(ctx.store, owner, name);
  if (repo === undefined) throw new ToolError('Not Found');
  if (repo.owner.toLowerCase() !== login.toLowerCase()) throw new ToolError('Not Found');
  return repo;
}

// ---------------------------------------------------------------------------
// The six tools (each returns the JSON value its content block carries)
// ---------------------------------------------------------------------------

function toolCreateRepo(ctx: IssuesCtx, args: Record<string, unknown>, login: string): unknown {
  const name = requiredStringArg(args, 'name');
  if (!isValidRepoName(name)) throw new ToolError('Invalid repository name');
  if (getRepo(ctx.store, login, name) !== undefined) throw new ToolError('Repository already exists');
  const repo: Repo = {
    id: ctx.store.nextRepoId,
    owner: login,
    name,
    description: optionalStringArg(args, 'description') ?? '',
    defaultBranch: 'main',
    private: args.private === true,
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
  return repoJsonMcp(ctx.store, repo);
}

function toolGetRepo(ctx: IssuesCtx, args: Record<string, unknown>, login: string): unknown {
  const owner = requiredStringArg(args, 'owner');
  const name = requiredStringArg(args, 'repo');
  const repo = requireRepoFor(ctx, owner, name, login);
  return repoJsonMcp(ctx.store, repo);
}

function toolCreateIssue(ctx: IssuesCtx, args: Record<string, unknown>, login: string): unknown {
  const owner = requiredStringArg(args, 'owner');
  const name = requiredStringArg(args, 'repo');
  const title = requiredStringArg(args, 'title');
  const body = optionalStringArg(args, 'body') ?? '';
  const repo = requireRepoFor(ctx, owner, name, login);
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const stamp = nowIso();
  const issue: Issue = {
    id: number,
    number,
    title,
    body,
    state: 'open',
    labels: [],
    user: login,
    createdAt: stamp,
    updatedAt: stamp,
    comments: new Map(),
    nextComment: 1,
  };
  repo.issues.set(number, issue);
  return issueJson(ctx, repo, issue);
}

function toolListIssues(ctx: IssuesCtx, args: Record<string, unknown>, login: string): unknown {
  const owner = requiredStringArg(args, 'owner');
  const name = requiredStringArg(args, 'repo');
  const state = optionalStringArg(args, 'state') ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') throw new ToolError('Invalid state');
  const repo = requireRepoFor(ctx, owner, name, login);
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => b.number - a.number);
  return issues.map((issue) => issueJson(ctx, repo, issue));
}

function toolCreatePullRequest(ctx: IssuesCtx, args: Record<string, unknown>, login: string): unknown {
  const owner = requiredStringArg(args, 'owner');
  const name = requiredStringArg(args, 'repo');
  const title = requiredStringArg(args, 'title');
  const body = optionalStringArg(args, 'body') ?? '';
  const headRef = requiredStringArg(args, 'head');
  const baseRef = requiredStringArg(args, 'base');
  const repo = requireRepoFor(ctx, owner, name, login);
  const headSha = repo.branches.get(headRef)?.sha;
  if (headSha === undefined) throw new ToolError(`head branch does not exist: ${headRef}`);
  const baseSha = repo.branches.get(baseRef)?.sha;
  if (baseSha === undefined) throw new ToolError(`base branch does not exist: ${baseRef}`);
  if (headRef === baseRef) throw new ToolError('head and base must be different branches');
  const base = mergeBase(ctx.git, headSha, baseSha);
  const baseMap = base === null ? new Map<string, string>() : treeOfCommit(ctx.git, base);
  const headMap = treeOfCommit(ctx.git, headSha);
  const changes = diffTrees(baseMap, headMap);
  if (changes.length === 0) throw new ToolError('head and base have no differences');
  const number = repo.nextPull;
  repo.nextPull += 1;
  const stamp = nowIso();
  const pull: Pull = {
    id: number,
    number,
    title,
    body,
    state: 'open',
    head: { ref: headRef, sha: headSha },
    base: { ref: baseRef, sha: baseSha },
    merged: false,
    mergeCommitSha: null,
    changedPaths: changes,
    user: login,
    createdAt: stamp,
    updatedAt: stamp,
  };
  repo.pulls.set(number, pull);
  return pullJsonMcp(ctx, repo, pull);
}

function toolMergePullRequest(ctx: IssuesCtx, args: Record<string, unknown>, login: string): unknown {
  const owner = requiredStringArg(args, 'owner');
  const name = requiredStringArg(args, 'repo');
  const number = pullNumberArg(args, 'pull_number');
  const repo = requireRepoFor(ctx, owner, name, login);
  const pull = repo.pulls.get(number);
  if (pull === undefined) throw new ToolError('Not Found');
  if (pull.state === 'merged') throw new ToolError('Pull request already merged');
  if (pull.state === 'closed') throw new ToolError('Pull request is closed');
  const { headSha, baseSha } = liveTips(repo, pull);
  if (headSha === baseSha) throw new ToolError('Nothing to merge');
  const conflictPath = findConflict(ctx.git, baseSha, headSha);
  if (conflictPath !== null) throw new ToolError(`Merge conflict in ${conflictPath}`);
  const base = mergeBase(ctx.git, headSha, baseSha);
  const baseMap = base === null ? new Map<string, string>() : treeOfCommit(ctx.git, base);
  const headMap = treeOfCommit(ctx.git, headSha);
  if (diffTrees(baseMap, headMap).length === 0) throw new ToolError('Nothing to merge');
  const sha = squashMerge(ctx, repo, pull, login);
  pull.state = 'merged';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.updatedAt = nowIso();
  return pullJsonMcp(ctx, repo, pull);
}

const TOOL_IMPL: Readonly<Record<string, (ctx: IssuesCtx, args: Record<string, unknown>, login: string) => unknown>> = {
  create_repo: toolCreateRepo,
  get_repo: toolGetRepo,
  create_issue: toolCreateIssue,
  list_issues: toolListIssues,
  create_pull_request: toolCreatePullRequest,
  merge_pull_request: toolMergePullRequest,
};

// ---------------------------------------------------------------------------
// JSON-RPC plumbing
// ---------------------------------------------------------------------------

function rpcResult(res: ServerResponse, id: JsonRpcId, result: unknown): void {
  sendJson(res, 200, { jsonrpc: '2.0', id, result });
}

function rpcError(res: ServerResponse, httpStatus: number, id: JsonRpcId, code: number, message: string, data?: unknown): void {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  sendJson(res, httpStatus, { jsonrpc: '2.0', id, error });
}

/** A tools/call success: one text block carrying the JSON result. */
function toolResult(res: ServerResponse, id: JsonRpcId, value: unknown): void {
  rpcResult(res, id, {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false,
  });
}

/** A tools/call failure: isError:true with the message as text. */
function toolErrorResult(res: ServerResponse, id: JsonRpcId, message: string): void {
  rpcResult(res, id, {
    content: [{ type: 'text', text: message }],
    isError: true,
  });
}

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** tools/call: validate, dispatch, answer (never a throw past this point). */
function handleToolsCall(
  ctx: IssuesCtx,
  res: ServerResponse,
  id: JsonRpcId,
  params: Record<string, unknown>,
  login: string,
): void {
  const name = params.name;
  if (typeof name !== 'string' || name === '') {
    rpcError(res, 200, id, INVALID_PARAMS, 'tools/call requires a tool name');
    return;
  }
  const impl = TOOL_IMPL[name];
  if (impl === undefined) {
    rpcError(res, 200, id, INVALID_PARAMS, `Unknown tool: ${name}`);
    return;
  }
  const rawArgs = params.arguments;
  if (rawArgs !== undefined && !isRecord(rawArgs)) {
    rpcError(res, 200, id, INVALID_PARAMS, 'arguments must be an object');
    return;
  }
  const args: Record<string, unknown> = rawArgs ?? {};
  // A missing required argument is a JSON-RPC invalid-params error.
  const def = TOOLS.find((tool) => tool.name === name);
  if (def !== undefined) {
    for (const field of def.inputSchema.required) {
      if (args[field] === undefined || args[field] === null) {
        rpcError(res, 200, id, INVALID_PARAMS, `${field} is required`);
        return;
      }
    }
  }
  try {
    const value = impl(ctx, args, login);
    toolResult(res, id, value);
  } catch (err) {
    if (err instanceof ToolError) {
      toolErrorResult(res, id, err.message);
      return;
    }
    toolErrorResult(res, id, err instanceof Error ? err.message : 'Internal error');
  }
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountMcp(ctx: RouterContext): RouteHandler {
  const mctx: IssuesCtx = { store: ctx.store, git: ctx.git };
  return async (req, res, pathname, method) => {
    if (pathname !== '/mcp' && pathname !== '/mcp/') return false;

    // A legacy session DELETE is a no-op success (we hand out no sessions).
    if (method === 'DELETE') {
      res.writeHead(204, { 'x-github-request-id': newRequestId() });
      res.end();
      return true;
    }
    if (method !== 'POST') {
      jsonError(res, 405, 'Method Not Allowed');
      return true;
    }

    // Auth first: no token is a 401, before any tool exists or any body parses.
    const login = authViewer(req, mctx.store);
    if (login === null) {
      jsonError(res, 401, 'Requires authentication');
      return true;
    }

    let raw: Buffer;
    try {
      raw = await readBody(req);
    } catch {
      jsonError(res, 413, 'Request body too large');
      return true;
    }

    // A body that is not JSON: HTTP 400 with JSON-RPC -32700.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8')) as unknown;
    } catch {
      rpcError(res, 400, null, PARSE_ERROR, 'Parse error');
      return true;
    }
    if (!isRecord(parsed)) {
      rpcError(res, 200, null, INVALID_REQUEST, 'Invalid Request');
      return true;
    }

    const id: JsonRpcId =
      parsed.id === undefined ? null : typeof parsed.id === 'string' || typeof parsed.id === 'number' ? parsed.id : null;
    const hasId = parsed.id !== undefined;
    const methodName = parsed.method;
    if (typeof methodName !== 'string' || methodName === '') {
      rpcError(res, 200, id, INVALID_REQUEST, 'Invalid Request');
      return true;
    }

    // Notifications carry no id: acknowledge with 202 and no body.
    if (!hasId) {
      res.writeHead(202, { 'x-github-request-id': newRequestId() });
      res.end();
      return true;
    }

    try {
      // The client declares its revision in the MCP-Protocol-Version header;
      // a revision we do not speak is a -32022 naming what we do speak.
      const declared = req.headers['mcp-protocol-version'];
      if (typeof declared === 'string' && declared !== '' && !SUPPORTED_VERSIONS.includes(declared)) {
        rpcError(res, 200, id, UNSUPPORTED_VERSION, `Unsupported protocol version: ${declared}`, { supported: [...SUPPORTED_VERSIONS] });
        return true;
      }

      const params: Record<string, unknown> = isRecord(parsed.params) ? parsed.params : {};

      if (methodName === 'server/discover') {
        rpcResult(res, id, {
          supportedVersions: [...SUPPORTED_VERSIONS],
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
        });
        return true;
      }

      if (methodName === 'initialize') {
        const requested = params.protocolVersion;
        const negotiated =
          typeof requested === 'string' && SUPPORTED_VERSIONS.includes(requested) ? requested : PREFERRED_VERSION;
        rpcResult(res, id, {
          protocolVersion: negotiated,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
        });
        return true;
      }

      if (methodName === 'ping') {
        rpcResult(res, id, {});
        return true;
      }

      if (methodName === 'tools/list') {
        // TOOLS is a fixed literal: the same tools, byte for byte, every call.
        rpcResult(res, id, { tools: TOOLS });
        return true;
      }

      if (methodName === 'tools/call') {
        handleToolsCall(mctx, res, id, params, login);
        return true;
      }

      rpcError(res, 200, id, METHOD_NOT_FOUND, `Method not found: ${methodName}`);
      return true;
    } catch (err) {
      // Never a bare 500 for a JSON-RPC request: an internal error object.
      if (!res.headersSent) {
        rpcError(res, 200, id, INTERNAL_ERROR, err instanceof Error ? err.message : 'Internal error');
      }
      return true;
    }
  };
}
