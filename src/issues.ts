// Issues, labels and comments (M2): the REST v3 namespaces rest.ts leaves to
// this module. Mounted by app.ts after mountRest; claims every
// /api/v3/repos/{owner}/{repo}/labels|issues[/...] path.
//
// Every reply goes through sendJson/jsonError (non-empty X-GitHub-Request-Id,
// JSON body). Auth is the same viewer derivation as M1, imported from
// ./rest.ts (authViewer) so the token maps to the same login. A repository
// under any other owner is a 404, never a 403; no token is a 401.
//
// Labels must exist before an issue may use them: creating or patching an
// issue (or adding labels to one) with an unknown label is a 422 with a
// {"message"} body. Timestamps come from src/clock.ts; no Date.now() /
// Math.random() in request code. All state lives in the Store.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { nowIso } from './clock.ts';
import { authViewer } from './rest.ts';
import type { RouteHandler, RouterContext } from './router.ts';
import type { GitStore, Issue, Label, Repo, Store } from './store.ts';
import { getRepo, repoKey } from './store.ts';
import {
  BodyTooLargeError,
  MalformedJsonError,
  jsonError,
  newRequestId,
  parseJsonBody,
  requestQuery,
  requestSegments,
  sendJson,
} from './util.ts';

/** Split a pathname into decoded segments (re-exported for pulls.ts). */
export { splitPath } from './util.ts';
/** The request's query parameters (re-exported for pulls.ts). */
export { requestQuery as queryOf } from './util.ts';

// ---------------------------------------------------------------------------
// Errors + small helpers (same contract as rest.ts)
// ---------------------------------------------------------------------------

/** An error that maps straight onto a JSON error reply. */
export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, message);
}

export function notFound(message = 'Not Found'): ApiError {
  return new ApiError(404, message);
}

export function unprocessable(message: string): ApiError {
  return new ApiError(422, message);
}

export function conflict(message: string): ApiError {
  return new ApiError(409, message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a JSON object body; undefined when there is no body. */
export async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const body = await parseJsonBody(req);
  if (body === undefined) return undefined;
  if (!isRecord(body)) throw unprocessable('Request body must be a JSON object');
  return body;
}

export function requiredString(body: Record<string, unknown> | undefined, field: string): string {
  const value = body?.[field];
  if (typeof value !== 'string' || value === '') throw unprocessable(`${field} is required`);
  return value;
}

export function optionalString(body: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = body?.[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw unprocessable(`${field} must be a string`);
  return value;
}

// ---------------------------------------------------------------------------
// Pagination (same Link-header contract as rest.ts)
// ---------------------------------------------------------------------------

interface PageParams {
  page: number;
  perPage: number;
}

export function pageParams(query: URLSearchParams): PageParams {
  let page = Number.parseInt(query.get('page') ?? '1', 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  let perPage = Number.parseInt(query.get('per_page') ?? '30', 10);
  if (!Number.isFinite(perPage) || perPage < 1) perPage = 30;
  if (perPage > 100) perPage = 100;
  return { page, perPage };
}

/**
 * Slice `items` to one page and build the GitHub `Link` header (absolute
 * URLs on this entry's origin, preserving the query). Present only when
 * another page exists in either direction.
 */
export function paginate<T>(
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
// Repo lookup + serializers
// ---------------------------------------------------------------------------

export interface IssuesCtx {
  store: Store;
  git: GitStore;
}

/** The repo at {owner}/{name}, 404 when missing or owned by someone else. */
export function requireRepo(ctx: IssuesCtx, owner: string, name: string, login: string): Repo {
  const repo = getRepo(ctx.store, owner, name);
  if (repo === undefined) throw notFound('Not Found');
  if (repo.owner.toLowerCase() !== login.toLowerCase()) throw notFound('Not Found');
  return repo;
}

export function userJson(store: Store, login: string): Record<string, unknown> {
  const user = store.users.get(login.toLowerCase());
  return {
    login,
    id: user?.id ?? 0,
    node_id: `U_${user?.id ?? 0}`,
    type: 'User',
    site_admin: false,
  };
}

export function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  return {
    id: label.id,
    node_id: `L_${label.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    default: false,
    description: label.description,
  };
}

/** The labels attached to an issue, as full label objects (canonical names). */
export function issueLabelsJson(repo: Repo, issue: Issue): Record<string, unknown>[] {
  return issue.labels.map((name) => {
    const label = repo.labels.get(name.toLowerCase());
    if (label === undefined) return { name, color: 'ededed', description: '' };
    return labelJson(repo, label);
  });
}

export function issueJson(ctx: IssuesCtx, repo: Repo, issue: Issue): Record<string, unknown> {
  const base = `/api/v3/repos/${repo.owner}/${repo.name}`;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    url: `${base}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    user: userJson(ctx.store, issue.user),
    labels: issueLabelsJson(repo, issue),
    assignees: [],
    comments: issue.comments.size,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
  };
}

export function commentJson(ctx: IssuesCtx, repo: Repo, issue: Issue, id: number): Record<string, unknown> {
  const comment = issue.comments.get(id);
  if (comment === undefined) throw notFound('Not Found');
  return {
    id: comment.id,
    node_id: `C_${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(ctx.store, comment.user),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** Resolve a label name against the repo (case-insensitive), 404 when absent. */
function requireLabel(repo: Repo, name: string): Label {
  const label = repo.labels.get(name.toLowerCase());
  if (label === undefined) throw notFound('Not Found');
  return label;
}

/**
 * Validate a `labels` value from a request body: an array of strings, every
 * one an existing label. Returns the canonical label names. Unknown label or
 * wrong type is a 422.
 */
export function resolveLabelNames(repo: Repo, value: unknown): string[] {
  if (!Array.isArray(value)) throw unprocessable('labels must be an array of label names');
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') throw unprocessable('labels must be an array of label names');
    const label = repo.labels.get(entry.toLowerCase());
    if (label === undefined) throw unprocessable(`Label does not exist: ${entry}`);
    if (!out.includes(label.name)) out.push(label.name);
  }
  return out;
}

async function createLabelHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
): Promise<void> {
  const body = await readJsonObject(req);
  const name = requiredString(body, 'name');
  if (repo.labels.has(name.toLowerCase())) throw unprocessable('Label already exists');
  const color = optionalString(body, 'color') ?? 'ededed';
  const description = optionalString(body, 'description') ?? '';
  const label: Label = { id: repo.nextLabel, name, color, description };
  repo.nextLabel += 1;
  repo.labels.set(name.toLowerCase(), label);
  sendJson(res, 201, labelJson(repo, label));
}

function listLabelsHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  repo: Repo,
): void {
  const labels = [...repo.labels.values()].sort((a, b) => a.id - b.id);
  const { page, headers } = paginate(req, query, labels);
  sendJson(res, 200, page.map((label) => labelJson(repo, label)), headers);
}

async function patchLabelHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  name: string,
): Promise<void> {
  const label = requireLabel(repo, name);
  const body = await readJsonObject(req);
  const oldName = label.name;
  if (body !== undefined) {
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name === '') throw unprocessable('name is required');
      const clash = repo.labels.get((body.name as string).toLowerCase());
      if (clash !== undefined && clash !== label) throw unprocessable('Label already exists');
    }
    if (body.color !== undefined) {
      if (typeof body.color !== 'string') throw unprocessable('color must be a string');
      label.color = body.color;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        throw unprocessable('description must be a string');
      }
      label.description = (body.description as string | null) ?? '';
    }
    if (body.name !== undefined) {
      repo.labels.delete(oldName.toLowerCase());
      label.name = body.name as string;
      repo.labels.set(label.name.toLowerCase(), label);
      // Keep attached issues on the renamed label.
      for (const issue of repo.issues.values()) {
        issue.labels = issue.labels.map((entry) => (entry.toLowerCase() === oldName.toLowerCase() ? label.name : entry));
      }
    }
  }
  sendJson(res, 200, labelJson(repo, label));
}

function deleteLabelHandler(ctx: IssuesCtx, res: ServerResponse, repo: Repo, name: string): void {
  const label = requireLabel(repo, name);
  repo.labels.delete(label.name.toLowerCase());
  for (const issue of repo.issues.values()) {
    issue.labels = issue.labels.filter((entry) => entry.toLowerCase() !== label.name.toLowerCase());
  }
  res.writeHead(204, { 'x-github-request-id': newRequestId() });
  res.end();
}

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

function requireIssue(repo: Repo, numberRaw: string): Issue {
  const number = Number.parseInt(numberRaw, 10);
  if (!Number.isInteger(number) || number < 1) throw notFound('Not Found');
  const issue = repo.issues.get(number);
  if (issue === undefined) throw notFound('Not Found');
  return issue;
}

async function createIssueHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  login: string,
): Promise<void> {
  const body = await readJsonObject(req);
  const title = requiredString(body, 'title');
  const issueBody = optionalString(body, 'body') ?? '';
  const labels = body?.labels === undefined ? [] : resolveLabelNames(repo, body.labels);
  const number = repo.nextIssue;
  repo.nextIssue += 1;
  const stamp = nowIso();
  const issue: Issue = {
    id: number,
    number,
    title,
    body: issueBody,
    state: 'open',
    labels,
    user: login,
    createdAt: stamp,
    updatedAt: stamp,
    comments: new Map(),
    nextComment: 1,
  };
  repo.issues.set(number, issue);
  sendJson(res, 201, issueJson(ctx, repo, issue));
}

function listIssuesHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  repo: Repo,
): void {
  const state = query.get('state') ?? 'open';
  if (state !== 'open' && state !== 'closed' && state !== 'all') throw unprocessable('Invalid state');
  const labelFilter = query.get('labels');
  const wanted = labelFilter === null || labelFilter === '' ? [] : labelFilter.split(',').map((entry) => entry.trim().toLowerCase()).filter((entry) => entry !== '');
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (wanted.length > 0) {
    issues = issues.filter((issue) => wanted.every((name) => issue.labels.some((entry) => entry.toLowerCase() === name)));
  }
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  } else if (direction === 'asc') {
    issues.sort((a, b) => a.number - b.number);
  } else {
    issues.sort((a, b) => b.number - a.number);
  }
  const { page, headers } = paginate(req, query, issues);
  sendJson(res, 200, page.map((issue) => issueJson(ctx, repo, issue)), headers);
}

async function patchIssueHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  issue: Issue,
): Promise<void> {
  const body = await readJsonObject(req);
  if (body !== undefined) {
    if (body.title !== undefined) {
      if (typeof body.title !== 'string' || body.title === '') throw unprocessable('title is required');
      issue.title = body.title;
    }
    if (body.body !== undefined) {
      if (body.body !== null && typeof body.body !== 'string') throw unprocessable('body must be a string');
      issue.body = (body.body as string | null) ?? '';
    }
    if (body.state !== undefined) {
      if (body.state !== 'open' && body.state !== 'closed') throw unprocessable('Invalid state');
      issue.state = body.state;
    }
    if (body.labels !== undefined) {
      issue.labels = resolveLabelNames(repo, body.labels);
    }
  }
  issue.updatedAt = nowIso();
  sendJson(res, 200, issueJson(ctx, repo, issue));
}

// ---------------------------------------------------------------------------
// Issue comments
// ---------------------------------------------------------------------------

async function createCommentHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  issue: Issue,
  login: string,
): Promise<void> {
  const body = await readJsonObject(req);
  const text = requiredString(body, 'body');
  const id = repo.nextComment;
  repo.nextComment += 1;
  const stamp = nowIso();
  issue.comments.set(id, { id, body: text, user: login, createdAt: stamp, updatedAt: stamp });
  issue.updatedAt = stamp;
  sendJson(res, 201, commentJson(ctx, repo, issue, id));
}

function listCommentsHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  query: URLSearchParams,
  repo: Repo,
  issue: Issue,
): void {
  const ids = [...issue.comments.keys()].sort((a, b) => a - b);
  const { page, headers } = paginate(req, query, ids);
  sendJson(res, 200, page.map((id) => commentJson(ctx, repo, issue, id)), headers);
}

function requireComment(issue: Issue, idRaw: string): number {
  const id = Number.parseInt(idRaw, 10);
  if (!Number.isInteger(id) || id < 1 || !issue.comments.has(id)) throw notFound('Not Found');
  return id;
}

async function patchCommentHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  issue: Issue,
  id: number,
): Promise<void> {
  const comment = issue.comments.get(id);
  if (comment === undefined) throw notFound('Not Found');
  const body = await readJsonObject(req);
  const text = requiredString(body, 'body');
  comment.body = text;
  comment.updatedAt = nowIso();
  sendJson(res, 200, commentJson(ctx, repo, issue, id));
}

function deleteCommentHandler(ctx: IssuesCtx, res: ServerResponse, issue: Issue, id: number): void {
  if (!issue.comments.delete(id)) throw notFound('Not Found');
  res.writeHead(204, { 'x-github-request-id': newRequestId() });
  res.end();
}

// ---------------------------------------------------------------------------
// Issue labels (add / remove)
// ---------------------------------------------------------------------------

async function addIssueLabelsHandler(
  ctx: IssuesCtx,
  req: IncomingMessage,
  res: ServerResponse,
  repo: Repo,
  issue: Issue,
): Promise<void> {
  const raw = await parseJsonBody(req);
  let value: unknown;
  if (Array.isArray(raw)) value = raw;
  else if (isRecord(raw)) value = raw.labels;
  else throw unprocessable('labels must be an array of label names');
  const names = resolveLabelNames(repo, value);
  for (const name of names) {
    if (!issue.labels.includes(name)) issue.labels.push(name);
  }
  issue.updatedAt = nowIso();
  sendJson(res, 200, issueLabelsJson(repo, issue));
}

function removeIssueLabelHandler(ctx: IssuesCtx, res: ServerResponse, repo: Repo, issue: Issue, name: string): void {
  requireLabel(repo, name);
  const idx = issue.labels.findIndex((entry) => entry.toLowerCase() === name.toLowerCase());
  if (idx === -1) throw notFound('Not Found');
  issue.labels.splice(idx, 1);
  issue.updatedAt = nowIso();
  res.writeHead(204, { 'x-github-request-id': newRequestId() });
  res.end();
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountIssues(ctx: RouterContext): RouteHandler {
  const ictx: IssuesCtx = { store: ctx.store, git: ctx.git };
  return async (req, res, pathname, method) => {
    if (!pathname.startsWith('/api/v3/repos/')) return false;
    const segments = requestSegments(req, pathname);
    // segments: api, v3, repos, {owner}, {repo}, {labels|issues}[, ...]
    if (segments.length < 6 || segments[2] !== 'repos') return false;
    const tail = segments.slice(5);
    if (tail[0] !== 'labels' && tail[0] !== 'issues') return false;

    const login = authViewer(req, ictx.store);
    if (login === null) {
      jsonError(res, 401, 'Requires authentication');
      return true;
    }

    const owner = segments[3] ?? '';
    const name = segments[4] ?? '';
    const query = requestQuery(req);
    try {
      const repo = requireRepo(ictx, owner, name, login);

      if (tail[0] === 'labels') {
        if (tail.length === 1) {
          if (method === 'POST') {
            await createLabelHandler(ictx, req, res, repo);
            return true;
          }
          if (method === 'GET') {
            listLabelsHandler(ictx, req, res, query, repo);
            return true;
          }
          return false;
        }
        if (tail.length === 2) {
          const labelName = tail[1] ?? '';
          if (method === 'GET') {
            sendJson(res, 200, labelJson(repo, requireLabel(repo, labelName)));
            return true;
          }
          if (method === 'PATCH') {
            await patchLabelHandler(ictx, req, res, repo, labelName);
            return true;
          }
          if (method === 'DELETE') {
            deleteLabelHandler(ictx, res, repo, labelName);
            return true;
          }
          return false;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }

      // tail[0] === 'issues'
      if (tail.length === 1) {
        if (method === 'POST') {
          await createIssueHandler(ictx, req, res, repo, login);
          return true;
        }
        if (method === 'GET') {
          listIssuesHandler(ictx, req, res, query, repo);
          return true;
        }
        return false;
      }
      const issue = requireIssue(repo, tail[1] ?? '');
      if (tail.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(ictx, repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          await patchIssueHandler(ictx, req, res, repo, issue);
          return true;
        }
        return false;
      }
      if (tail[2] === 'comments') {
        if (tail.length === 3) {
          if (method === 'POST') {
            await createCommentHandler(ictx, req, res, repo, issue, login);
            return true;
          }
          if (method === 'GET') {
            listCommentsHandler(ictx, req, res, query, repo, issue);
            return true;
          }
          return false;
        }
        if (tail.length === 4) {
          const commentId = requireComment(issue, tail[3] ?? '');
          if (method === 'PATCH') {
            await patchCommentHandler(ictx, req, res, repo, issue, commentId);
            return true;
          }
          if (method === 'DELETE') {
            deleteCommentHandler(ictx, res, issue, commentId);
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, commentJson(ictx, repo, issue, commentId));
            return true;
          }
          return false;
        }
        jsonError(res, 404, 'Not Found');
        return true;
      }
      if (tail[2] === 'labels') {
        if (tail.length === 3) {
          if (method === 'POST') {
            await addIssueLabelsHandler(ictx, req, res, repo, issue);
            return true;
          }
          if (method === 'GET') {
            sendJson(res, 200, issueLabelsJson(repo, issue));
            return true;
          }
          return false;
        }
        if (tail.length === 4) {
          if (method === 'DELETE') {
            removeIssueLabelHandler(ictx, res, repo, issue, tail[3] ?? '');
            return true;
          }
          return false;
        }
        jsonError(res, 404, 'Not Found');
        return true;
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
