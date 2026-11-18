// GraphQL v4 (M4): a minimal executor for exactly the documents gh and
// github-mcp-server send (see the kit's checks-graphql.ts / graphql-client.ts
// for the document list — this file implements them from that spec, with no
// general GraphQL library and no copied code).
//
// Supported surface:
//   Query.viewer / repository / repositoryOwner / node / search / __type / __schema
//   Repository.{id,databaseId,name,nameWithOwner,owner,defaultBranchRef,
//     viewerPermission,hasIssuesEnabled,issue,issues,pullRequests,pullRequest}
//   Issue / PullRequest reads incl. issues(first,after,states,orderBy) cursor
//     pagination, pullRequest.files(first)
//   Mutation.createIssue / closeIssue / createPullRequest / mergePullRequest /
//     addComment — all writing to the same Store the REST surface reads, so a
//     mutation is visible through REST immediately.
//   Operation batching: a JSON array body answers one envelope per operation,
//     in order.
//   Unknown fields are GraphQL errors (HTTP 200 + errors array naming the
//     field), never HTTP 400/500. An unknown repository is data.repository =
//     null with no errors.
//
// Auth is the same viewer derivation as M1 (authViewer from ./rest.ts): no
// token is a 401; a malformed JSON body is a 400. Every other answer is
// HTTP 200 with {data, errors?}. Timestamps come from src/clock.ts; no
// Date.now()/Math.random() in request code. All state lives in the Store.

import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { nowIso, nowMs } from './clock.ts';
import { authViewer } from './rest.ts';
import type { RouteHandler, RouterContext } from './router.ts';
import type { GitStore, Issue, Pull, Repo, Store } from './store.ts';
import { getRepo, repoKey } from './store.ts';
import {
  BodyTooLargeError,
  MalformedJsonError,
  jsonError,
  parseJsonBody,
  sendJson,
} from './util.ts';

// ---------------------------------------------------------------------------
// Global (Relay) ids: base64 of "Kind:repoId:number..." — opaque, stable,
// never the bare database id or number (the global-id check requires that).
// ---------------------------------------------------------------------------

function encodeGlobalId(kind: string, parts: readonly (string | number)[]): string {
  return Buffer.from([kind, ...parts.map(String)].join(':'), 'utf8').toString('base64');
}

interface DecodedId {
  kind: string;
  repoId: number;
  number: number;
  commentId: number;
}

function decodeGlobalId(value: unknown): DecodedId | null {
  if (typeof value !== 'string' || value === '') return null;
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const parts = text.split(':');
  const kind = parts[0] ?? '';
  const repoId = Number.parseInt(parts[1] ?? '', 10);
  if (kind === '' || !Number.isInteger(repoId)) return null;
  return {
    kind,
    repoId,
    number: Number.parseInt(parts[2] ?? '', 10),
    commentId: Number.parseInt(parts[3] ?? '', 10),
  };
}

function findRepoById(store: Store, repoId: number): Repo | undefined {
  for (const repo of store.repos.values()) {
    if (repo.id === repoId) return repo;
  }
  return undefined;
}

function repoGlobalId(repo: Repo): string {
  return encodeGlobalId('Repository', [repo.id]);
}

function issueGlobalId(repo: Repo, issue: Issue): string {
  return encodeGlobalId('Issue', [repo.id, issue.number]);
}

function pullGlobalId(repo: Repo, pull: Pull): string {
  return encodeGlobalId('PullRequest', [repo.id, pull.number]);
}

function commentGlobalId(repo: Repo, issueNumber: number, commentId: number): string {
  return encodeGlobalId('IssueComment', [repo.id, issueNumber, commentId]);
}

// ---------------------------------------------------------------------------
// Cursor pagination: base64 of "cursor:<index>" into the filtered list.
// ---------------------------------------------------------------------------

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(value: unknown): number {
  if (typeof value !== 'string' || value === '') return -1;
  let text: string;
  try {
    text = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return -1;
  }
  const match = /^cursor:(\d+)$/.exec(text) ?? /^(\d+)$/.exec(text);
  if (match === null) return -1;
  const index = Number.parseInt(match[1] ?? '', 10);
  return Number.isInteger(index) ? index : -1;
}

// ---------------------------------------------------------------------------
// Tokenizer + parser for the small GraphQL subset the clients send.
// ---------------------------------------------------------------------------

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'eof';

interface Token {
  kind: TokenKind;
  value: string;
}

const PUNCT = new Set(['!', '$', '(', ')', ':', '=', '@', '[', ']', '{', '}', '|', '&']);

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] ?? '';
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if (PUNCT.has(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] ?? '';
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u') {
            out += String.fromCharCode(Number.parseInt(source.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += source[j] ?? '';
          j += 1;
        }
      }
      if (j >= source.length) throw new ParseError('Unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] ?? '')) j += 1;
      let isFloat = false;
      if (source[j] === '.' && /[0-9]/.test(source[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] ?? '')) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] ?? '')) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_A-Za-z0-9]/.test(source[j] ?? '')) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  alias: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: SelectionNode[];
}

type SelectionNode =
  | FieldNode
  | { kind: 'fragmentSpread'; name: string }
  | { kind: 'inlineFragment'; typeCondition: string | null; selections: SelectionNode[] };

interface OperationNode {
  opType: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; defaultValue: ValueNode | null }>;
  selections: SelectionNode[];
}

interface FragmentNode {
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos] ?? { kind: 'eof', value: '' };
  }

  private next(): Token {
    const token = this.tokens[this.pos] ?? { kind: 'eof', value: '' };
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new ParseError(`Expected "${value}" but got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new ParseError(`Expected name${value === undefined ? '' : ` "${value}"`} but got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private atPunct(value: string): boolean {
    const token = this.peek();
    return token.kind === 'punct' && token.value === value;
  }

  private skipDirectives(): void {
    while (this.atPunct('@')) {
      this.next();
      this.expectName();
      if (this.atPunct('(')) this.parseArgs();
    }
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      if (this.peek().kind === 'name' && this.peek().value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName('on');
        const typeCondition = this.expectName();
        this.skipDirectives();
        const selections = this.parseSelectionSet();
        fragments.set(name, { name, typeCondition, selections });
        continue;
      }
      operations.push(this.parseOperation());
    }
    if (operations.length === 0) throw new ParseError('Document contains no operation');
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let opType: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      opType = this.next().value as 'query' | 'mutation';
      if (this.peek().kind === 'name') name = this.next().value;
    } else if (token.kind === 'punct' && token.value === '{') {
      opType = 'query';
    } else {
      throw new ParseError(`Expected an operation but got ${JSON.stringify(token.value)}`);
    }
    const varDefs: OperationNode['varDefs'] = [];
    if (this.atPunct('(')) {
      this.next();
      while (!this.atPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseTypeRef();
        let defaultValue: ValueNode | null = null;
        if (this.atPunct('=')) {
          this.next();
          defaultValue = this.parseValue();
        }
        varDefs.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    this.skipDirectives();
    const selections = this.parseSelectionSet();
    return { opType, name, varDefs, selections };
  }

  /** Consume a type reference ($var: String!, [IssueState!], ...) without keeping it. */
  private parseTypeRef(): void {
    if (this.atPunct('[')) {
      this.next();
      this.parseTypeRef();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.atPunct('!')) this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.atPunct('}')) {
      if (this.peek().kind === 'eof') throw new ParseError('Unterminated selection set');
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    if (this.atPunct('...')) {
      this.next();
      const token = this.peek();
      if (token.kind === 'name' && token.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inlineFragment', typeCondition, selections: this.parseSelectionSet() };
      }
      if (token.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'fragmentSpread', name };
      }
      this.skipDirectives();
      return { kind: 'inlineFragment', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias = first;
    let name = first;
    if (this.atPunct(':')) {
      this.next();
      name = this.expectName();
    }
    const args = this.atPunct('(') ? this.parseArgs() : [];
    this.skipDirectives();
    const selections = this.atPunct('{') ? this.parseSelectionSet() : [];
    return { kind: 'field', alias, name, args, selections };
  }

  private parseArgs(): Array<{ name: string; value: ValueNode }> {
    this.expectPunct('(');
    const args: Array<{ name: string; value: ValueNode }> = [];
    while (!this.atPunct(')')) {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!this.atPunct(']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.atPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------
// Schema tables for __type introspection.
// ---------------------------------------------------------------------------

interface TypeDef {
  kind: 'OBJECT' | 'ENUM';
  fields: string[];
  enumValues?: string[];
}

const TYPE_DEFS: Readonly<Record<string, TypeDef>> = {
  Query: {
    kind: 'OBJECT',
    fields: ['viewer', 'repository', 'repositoryOwner', 'node', 'search'],
  },
  Mutation: {
    kind: 'OBJECT',
    fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  },
  Repository: {
    kind: 'OBJECT',
    fields: [
      'id', 'databaseId', 'name', 'nameWithOwner', 'description', 'owner', 'defaultBranchRef',
      'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest',
      'url', 'createdAt', 'updatedAt',
    ],
  },
  Issue: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'author', 'labels', 'createdAt', 'updatedAt',
      'comments', 'url', 'repository',
    ],
  },
  PullRequest: {
    kind: 'OBJECT',
    fields: [
      'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName',
      'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'author', 'createdAt', 'updatedAt',
      'url', 'repository',
    ],
  },
  User: { kind: 'OBJECT', fields: ['id', 'databaseId', 'login', 'url'] },
  Ref: { kind: 'OBJECT', fields: ['name', 'prefix'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  PullRequestChangedFileEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path'] },
  SearchResultItemConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  SearchResultItemEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'] },
  Label: { kind: 'OBJECT', fields: ['id', 'name', 'color', 'description'] },
  LabelConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  LabelEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'author', 'createdAt', 'updatedAt'] },
  IssueCommentConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'pageInfo', 'totalCount'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'clientMutationId'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
};

// ---------------------------------------------------------------------------
// Git object reading (fresh helpers over ctx.git): trees, commits, ancestry,
// merge-base and diffs — the same objects the REST pulls module reads.
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

function parseCommit(raw: Buffer): { tree: string; parents: string[] } {
  const text = raw.toString('utf8');
  const head = text.split('\n\n')[0] ?? '';
  const out = { tree: '', parents: [] as string[] };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) out.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) out.parents.push(line.slice(7).trim());
  }
  return out;
}

function readCommit(git: GitStore, sha: string): { tree: string; parents: string[] } | null {
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

function ancestorsOf(git: GitStore, sha: string): Set<string> {
  const seen = new Set<string>();
  const queue = [sha];
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i] ?? '';
    if (seen.has(current)) continue;
    seen.add(current);
    const commit = readCommit(git, current);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return seen;
}

function mergeBaseOf(git: GitStore, headSha: string, baseSha: string): string | null {
  const baseAncestors = ancestorsOf(git, baseSha);
  const seen = new Set<string>();
  const queue = [headSha];
  for (let i = 0; i < queue.length; i += 1) {
    const current = queue[i] ?? '';
    if (seen.has(current)) continue;
    seen.add(current);
    if (baseAncestors.has(current)) return current;
    const commit = readCommit(git, current);
    if (commit === null) continue;
    for (const parent of commit.parents) queue.push(parent);
  }
  return null;
}

/** Paths whose blob differs between two flattened trees, sorted. */
function diffPaths(base: Map<string, string>, head: Map<string, string>): string[] {
  const out: string[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    if (base.get(path) !== head.get(path)) out.push(path);
  }
  return out;
}

/** A path both sides changed differently since the merge-base, or null. */
function findConflictPath(git: GitStore, baseSha: string, headSha: string): string | null {
  const base = mergeBaseOf(git, headSha, baseSha);
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

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

/** A runtime object value: its GraphQL type plus internal ($-prefixed) data. */
interface Obj {
  __typename: string;
  [key: string]: unknown;
}

interface GqlErrorEntry {
  message: string;
  path?: (string | number)[];
}

class GqlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GqlError';
  }
}

interface ExecCtx {
  store: Store;
  git: GitStore;
  login: string;
  fragments: Map<string, FragmentNode>;
  variables: Record<string, unknown>;
  errors: GqlErrorEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': {
      const value = variables[node.name];
      return value === undefined ? null : value;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

function resolveArgs(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

// --- value constructors -----------------------------------------------------

function userValue(store: Store, login: string): Obj {
  const user = store.users.get(login.toLowerCase());
  return { __typename: 'User', $login: login, $id: user?.id ?? 0 };
}

function repoValue(repo: Repo): Obj {
  return { __typename: 'Repository', $repo: repo };
}

function issueValue(repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', $repo: repo, $issue: issue };
}

function pullValue(repo: Repo, pull: Pull): Obj {
  return { __typename: 'PullRequest', $repo: repo, $pull: pull };
}

function pageInfoValue(hasNextPage: boolean, hasPreviousPage: boolean, startCursor: string | null, endCursor: string | null): Obj {
  return { __typename: 'PageInfo', $hasNextPage: hasNextPage, $hasPreviousPage: hasPreviousPage, $startCursor: startCursor, $endCursor: endCursor };
}

interface PageSlice<T> {
  nodes: T[];
  startIndex: number;
  total: number;
  hasNextPage: boolean;
}

function paginateList<T>(items: readonly T[], first: unknown, after: unknown): PageSlice<T> {
  const afterIndex = decodeCursor(after);
  const start = afterIndex + 1;
  const count = typeof first === 'number' && Number.isInteger(first) && first >= 0 ? first : items.length;
  const nodes = items.slice(start, start + count);
  return {
    nodes,
    startIndex: start,
    total: items.length,
    hasNextPage: start + nodes.length < items.length,
  };
}

function issueConnection(repo: Repo, issues: Issue[], args: Record<string, unknown>): Obj {
  let list = [...issues];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((entry) => String(entry).toUpperCase()));
    list = list.filter((issue) => wanted.has(issue.state.toUpperCase()));
  }
  const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
  const field = typeof orderBy.field === 'string' ? orderBy.field.toUpperCase() : 'CREATED_AT';
  const direction = typeof orderBy.direction === 'string' ? orderBy.direction.toUpperCase() : 'ASC';
  const cmp = (a: Issue, b: Issue): number => {
    let result = 0;
    if (field === 'UPDATED_AT') result = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else if (field === 'COMMENTS') result = a.comments.size - b.comments.size;
    else result = a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    if (result === 0) result = a.number - b.number;
    return direction === 'DESC' ? -result : result;
  };
  list.sort(cmp);
  const page = paginateList(list, args.first, args.after);
  const nodes = page.nodes.map((issue) => issueValue(repo, issue));
  const endCursor = nodes.length === 0 ? null : encodeCursor(page.startIndex + nodes.length - 1);
  const startCursor = nodes.length === 0 ? null : encodeCursor(page.startIndex);
  return {
    __typename: 'IssueConnection',
    $nodes: nodes,
    $total: page.total,
    $pageInfo: pageInfoValue(page.hasNextPage, page.startIndex > 0, startCursor, endCursor),
  };
}

function pullConnection(repo: Repo, pulls: Pull[], args: Record<string, unknown>): Obj {
  const list = [...pulls].sort((a, b) => b.number - a.number);
  const page = paginateList(list, args.first, args.after);
  const nodes = page.nodes.map((pull) => pullValue(repo, pull));
  const endCursor = nodes.length === 0 ? null : encodeCursor(page.startIndex + nodes.length - 1);
  const startCursor = nodes.length === 0 ? null : encodeCursor(page.startIndex);
  return {
    __typename: 'PullRequestConnection',
    $nodes: nodes,
    $total: page.total,
    $pageInfo: pageInfoValue(page.hasNextPage, page.startIndex > 0, startCursor, endCursor),
  };
}

function changedFilesConnection(repo: Repo, pull: Pull, args: Record<string, unknown>, git: GitStore): Obj {
  let paths = pull.changedPaths;
  if (paths.length === 0) {
    const headSha = repo.branches.get(pull.head.ref)?.sha ?? pull.head.sha;
    const baseSha = repo.branches.get(pull.base.ref)?.sha ?? pull.base.sha;
    const base = mergeBaseOf(git, headSha, baseSha);
    const baseMap = base === null ? new Map<string, string>() : treeOfCommit(git, base);
    paths = diffPaths(baseMap, treeOfCommit(git, headSha));
  }
  const page = paginateList(paths, args.first, args.after);
  const nodes = page.nodes.map((path) => ({ __typename: 'PullRequestChangedFile', $path: path }) as Obj);
  const endCursor = nodes.length === 0 ? null : encodeCursor(page.startIndex + nodes.length - 1);
  const startCursor = nodes.length === 0 ? null : encodeCursor(page.startIndex);
  return {
    __typename: 'PullRequestChangedFileConnection',
    $nodes: nodes,
    $total: page.total,
    $pageInfo: pageInfoValue(page.hasNextPage, page.startIndex > 0, startCursor, endCursor),
  };
}

function labelConnection(repo: Repo, issue: Issue, args: Record<string, unknown>): Obj {
  const labels = issue.labels.map((name) => {
    const label = repo.labels.get(name.toLowerCase());
    return {
      __typename: 'Label',
      $name: label?.name ?? name,
      $color: label?.color ?? 'ededed',
      $description: label?.description ?? '',
    } as Obj;
  });
  const page = paginateList(labels, args.first, args.after);
  const endCursor = page.nodes.length === 0 ? null : encodeCursor(page.startIndex + page.nodes.length - 1);
  const startCursor = page.nodes.length === 0 ? null : encodeCursor(page.startIndex);
  return {
    __typename: 'LabelConnection',
    $nodes: page.nodes,
    $total: page.total,
    $pageInfo: pageInfoValue(page.hasNextPage, page.startIndex > 0, startCursor, endCursor),
  };
}

function commentConnection(repo: Repo, issue: Issue, args: Record<string, unknown>): Obj {
  const ids = [...issue.comments.keys()].sort((a, b) => a - b);
  const page = paginateList(ids, args.first, args.after);
  const nodes = page.nodes.map((id) => {
    const comment = issue.comments.get(id);
    return {
      __typename: 'IssueComment',
      $repo: repo,
      $issue: issue,
      $commentId: id,
      $body: comment?.body ?? '',
      $user: comment?.user ?? issue.user,
      $createdAt: comment?.createdAt ?? issue.createdAt,
      $updatedAt: comment?.updatedAt ?? issue.updatedAt,
    } as Obj;
  });
  const endCursor = nodes.length === 0 ? null : encodeCursor(page.startIndex + nodes.length - 1);
  const startCursor = nodes.length === 0 ? null : encodeCursor(page.startIndex);
  return {
    __typename: 'IssueCommentConnection',
    $nodes: nodes,
    $total: page.total,
    $pageInfo: pageInfoValue(page.hasNextPage, page.startIndex > 0, startCursor, endCursor),
  };
}

// --- live pull helpers ------------------------------------------------------

function liveTips(repo: Repo, pull: Pull): { headSha: string; baseSha: string } {
  return {
    headSha: repo.branches.get(pull.head.ref)?.sha ?? pull.head.sha,
    baseSha: repo.branches.get(pull.base.ref)?.sha ?? pull.base.sha,
  };
}

function mergeableOf(ctx: ExecCtx, repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const { headSha, baseSha } = liveTips(repo, pull);
  const base = mergeBaseOf(ctx.git, headSha, baseSha);
  const baseMap = base === null ? new Map<string, string>() : treeOfCommit(ctx.git, base);
  const headMap = treeOfCommit(ctx.git, headSha);
  if (diffPaths(baseMap, headMap).length === 0) return 'UNKNOWN';
  return findConflictPath(ctx.git, baseSha, headSha) === null ? 'MERGEABLE' : 'CONFLICTING';
}

function pullStateOf(pull: Pull): string {
  if (pull.state === 'merged') return 'MERGED';
  if (pull.state === 'closed') return 'CLOSED';
  return 'OPEN';
}

/** The squash merge REST uses: one commit (head tree, base tip parent) on the base branch. */
function squashMerge(ctx: ExecCtx, repo: Repo, pull: Pull): string {
  const { headSha, baseSha } = liveTips(repo, pull);
  const headCommit = readCommit(ctx.git, headSha);
  const treeOid = headCommit?.tree ?? '';
  if (treeOid === '') throw new GqlError('head commit has no tree');
  const unix = Math.floor(nowMs() / 1000);
  const ident = `${ctx.login} <${ctx.login}@example.invalid> ${unix} +0000`;
  const message = `${pull.title} (#${pull.number})`;
  const text = `tree ${treeOid}\nparent ${baseSha}\nauthor ${ident}\ncommitter ${ident}\n\n${message}\n`;
  const sha = ctx.git.putObject('commit', Buffer.from(text, 'utf8'));
  ctx.git.setRef(repoKey(repo.owner, repo.name), `refs/heads/${pull.base.ref}`, sha);
  repo.updatedAt = nowIso();
  return sha;
}

// --- field resolution -------------------------------------------------------

function typeInfoValue(name: string): Obj | null {
  const def = TYPE_DEFS[name];
  if (def === undefined) return null;
  return { __typename: '__Type', $name: name, $kind: def.kind, $fields: def.fields, $enumValues: def.enumValues ?? null };
}

function resolveQueryField(field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  switch (field) {
    case 'viewer':
      return userValue(ctx.store, ctx.login);
    case 'repository': {
      const owner = asString(args.owner);
      const name = asString(args.name);
      if (owner === null || name === null) throw new GqlError('repository requires owner and name');
      const repo = getRepo(ctx.store, owner, name);
      return repo === undefined ? null : repoValue(repo);
    }
    case 'repositoryOwner': {
      const login = asString(args.login);
      if (login === null) throw new GqlError('repositoryOwner requires login');
      if (login.toLowerCase() === ctx.login.toLowerCase()) return userValue(ctx.store, ctx.login);
      for (const repo of ctx.store.repos.values()) {
        if (repo.owner.toLowerCase() === login.toLowerCase()) return userValue(ctx.store, repo.owner);
      }
      return null;
    }
    case 'node': {
      const decoded = decodeGlobalId(args.id);
      if (decoded === null) return null;
      const repo = findRepoById(ctx.store, decoded.repoId);
      if (repo === undefined) return null;
      if (decoded.kind === 'Repository') return repoValue(repo);
      if (decoded.kind === 'Issue') {
        const issue = repo.issues.get(decoded.number);
        return issue === undefined ? null : issueValue(repo, issue);
      }
      if (decoded.kind === 'PullRequest') {
        const pull = repo.pulls.get(decoded.number);
        return pull === undefined ? null : pullValue(repo, pull);
      }
      if (decoded.kind === 'IssueComment') {
        const issue = repo.issues.get(decoded.number);
        const comment = issue?.comments.get(decoded.commentId);
        if (issue === undefined || comment === undefined) return null;
        return {
          __typename: 'IssueComment',
          $repo: repo,
          $issue: issue,
          $commentId: comment.id,
          $body: comment.body,
          $user: comment.user,
          $createdAt: comment.createdAt,
          $updatedAt: comment.updatedAt,
        } as Obj;
      }
      return null;
    }
    case 'search': {
      const query = asString(args.query) ?? '';
      const type = typeof args.type === 'string' ? args.type.toUpperCase() : 'ISSUE';
      if (type !== 'ISSUE') {
        return {
          __typename: 'SearchResultItemConnection',
          $nodes: [],
          $total: 0,
          $pageInfo: pageInfoValue(false, false, null, null),
        } as Obj;
      }
      const words = query
        .split(/\s+/)
        .filter((word) => word !== '' && !word.includes(':'))
        .map((word) => word.toLowerCase());
      const hits: Obj[] = [];
      for (const repo of ctx.store.repos.values()) {
        if (repo.owner.toLowerCase() !== ctx.login.toLowerCase()) continue;
        for (const issue of repo.issues.values()) {
          const haystack = `${issue.title}\n${issue.body}`.toLowerCase();
          if (words.every((word) => haystack.includes(word))) hits.push(issueValue(repo, issue));
        }
      }
      hits.sort((a, b) => {
        const ia = a.$issue as Issue;
        const ib = b.$issue as Issue;
        return ib.number - ia.number;
      });
      const page = paginateList(hits, args.first, args.after);
      const endCursor = page.nodes.length === 0 ? null : encodeCursor(page.startIndex + page.nodes.length - 1);
      const startCursor = page.nodes.length === 0 ? null : encodeCursor(page.startIndex);
      return {
        __typename: 'SearchResultItemConnection',
        $nodes: page.nodes,
        $total: page.total,
        $pageInfo: pageInfoValue(page.hasNextPage, page.startIndex > 0, startCursor, endCursor),
      } as Obj;
    }
    case '__type': {
      const name = asString(args.name);
      if (name === null) throw new GqlError('__type requires name');
      return typeInfoValue(name);
    }
    case '__schema':
      return { __typename: '__Schema' } as Obj;
    default:
      throw new GqlError(`Cannot query field "${field}" on type "Query".`);
  }
}

function resolveRepositoryField(obj: Obj, field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const repo = obj.$repo as Repo;
  switch (field) {
    case 'id':
      return repoGlobalId(repo);
    case 'databaseId':
      return repo.id;
    case 'name':
      return repo.name;
    case 'nameWithOwner':
      return `${repo.owner}/${repo.name}`;
    case 'description':
      return repo.description;
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}`;
    case 'owner':
      return userValue(ctx.store, repo.owner);
    case 'defaultBranchRef':
      return { __typename: 'Ref', $name: repo.defaultBranch, $prefix: 'refs/heads/' } as Obj;
    case 'viewerPermission':
      return 'ADMIN';
    case 'hasIssuesEnabled':
      return true;
    case 'createdAt':
      return repo.createdAt;
    case 'updatedAt':
      return repo.updatedAt;
    case 'issue': {
      const number = asInt(args.number);
      if (number === null) throw new GqlError('issue requires number');
      const issue = repo.issues.get(number);
      return issue === undefined ? null : issueValue(repo, issue);
    }
    case 'issues':
      return issueConnection(repo, [...repo.issues.values()], args);
    case 'pullRequests':
      return pullConnection(repo, [...repo.pulls.values()], args);
    case 'pullRequest': {
      const number = asInt(args.number);
      if (number === null) throw new GqlError('pullRequest requires number');
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : pullValue(repo, pull);
    }
    default:
      throw new GqlError(`Cannot query field "${field}" on type "Repository".`);
  }
}

function resolveIssueField(obj: Obj, field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const repo = obj.$repo as Repo;
  const issue = obj.$issue as Issue;
  switch (field) {
    case 'id':
      return issueGlobalId(repo, issue);
    case 'number':
      return issue.number;
    case 'title':
      return issue.title;
    case 'body':
      return issue.body;
    case 'state':
      return issue.state === 'open' ? 'OPEN' : 'CLOSED';
    case 'author':
      return userValue(ctx.store, issue.user);
    case 'labels':
      return labelConnection(repo, issue, args);
    case 'createdAt':
      return issue.createdAt;
    case 'updatedAt':
      return issue.updatedAt;
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
    case 'repository':
      return repoValue(repo);
    case 'comments':
      return commentConnection(repo, issue, args);
    default:
      throw new GqlError(`Cannot query field "${field}" on type "Issue".`);
  }
}

function resolvePullField(obj: Obj, field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const repo = obj.$repo as Repo;
  const pull = obj.$pull as Pull;
  switch (field) {
    case 'id':
      return pullGlobalId(repo, pull);
    case 'number':
      return pull.number;
    case 'title':
      return pull.title;
    case 'body':
      return pull.body;
    case 'state':
      return pullStateOf(pull);
    case 'merged':
      return pull.merged;
    case 'mergeable':
      return mergeableOf(ctx, repo, pull);
    case 'headRefName':
      return pull.head.ref;
    case 'baseRefName':
      return pull.base.ref;
    case 'headRefOid':
      return liveTips(repo, pull).headSha;
    case 'baseRefOid':
      return liveTips(repo, pull).baseSha;
    case 'files':
      return changedFilesConnection(repo, pull, args, ctx.git);
    case 'author':
      return userValue(ctx.store, pull.user);
    case 'createdAt':
      return pull.createdAt;
    case 'updatedAt':
      return pull.updatedAt;
    case 'url':
      return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
    case 'repository':
      return repoValue(repo);
    default:
      throw new GqlError(`Cannot query field "${field}" on type "PullRequest".`);
  }
}

function resolveConnectionField(obj: Obj, field: string, ctx: ExecCtx): unknown {
  const nodes = (obj.$nodes ?? []) as Obj[];
  switch (field) {
    case 'nodes':
      return nodes;
    case 'edges': {
      const startIndex = typeof obj.$startIndex === 'number' ? obj.$startIndex : 0;
      const edgeType = `${obj.__typename.replace(/Connection$/, '')}Edge`;
      return nodes.map((node, i) => ({ __typename: edgeType, $node: node, $cursor: encodeCursor(startIndex + i) }) as Obj);
    }
    case 'pageInfo':
      return obj.$pageInfo ?? pageInfoValue(false, false, null, null);
    case 'totalCount':
      return typeof obj.$total === 'number' ? obj.$total : nodes.length;
    default:
      throw new GqlError(`Cannot query field "${field}" on type "${obj.__typename}".`);
  }
}

function resolveMutationField(field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  const input = isRecord(args.input) ? args.input : {};
  const clientMutationId = typeof input.clientMutationId === 'string' ? input.clientMutationId : null;
  switch (field) {
    case 'createIssue': {
      const decoded = decodeGlobalId(input.repositoryId);
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(ctx.store, decoded.repoId) : undefined;
      if (repo === undefined) throw new GqlError('createIssue: repository not found');
      const title = asString(input.title);
      if (title === null || title === '') throw new GqlError('createIssue: title is required');
      const body = asString(input.body) ?? '';
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
        user: ctx.login,
        createdAt: stamp,
        updatedAt: stamp,
        comments: new Map(),
        nextComment: 1,
      };
      repo.issues.set(number, issue);
      return {
        __typename: 'CreateIssuePayload',
        $issue: issueValue(repo, issue),
        $clientMutationId: clientMutationId,
      } as Obj;
    }
    case 'closeIssue': {
      const decoded = decodeGlobalId(input.issueId);
      const repo = decoded !== null && decoded.kind === 'Issue' ? findRepoById(ctx.store, decoded.repoId) : undefined;
      const issue = repo?.issues.get(decoded?.number ?? -1);
      if (repo === undefined || issue === undefined) throw new GqlError('closeIssue: issue not found');
      issue.state = 'closed';
      issue.updatedAt = nowIso();
      return {
        __typename: 'CloseIssuePayload',
        $issue: issueValue(repo, issue),
        $clientMutationId: clientMutationId,
      } as Obj;
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(input.repositoryId);
      const repo = decoded !== null && decoded.kind === 'Repository' ? findRepoById(ctx.store, decoded.repoId) : undefined;
      if (repo === undefined) throw new GqlError('createPullRequest: repository not found');
      const baseRef = asString(input.baseRefName);
      const headRef = asString(input.headRefName);
      const title = asString(input.title);
      if (baseRef === null || headRef === null || title === null || title === '') {
        throw new GqlError('createPullRequest: baseRefName, headRefName and title are required');
      }
      const headSha = repo.branches.get(headRef)?.sha;
      if (headSha === undefined) throw new GqlError(`createPullRequest: head branch does not exist: ${headRef}`);
      const baseSha = repo.branches.get(baseRef)?.sha;
      if (baseSha === undefined) throw new GqlError(`createPullRequest: base branch does not exist: ${baseRef}`);
      if (headRef === baseRef) throw new GqlError('createPullRequest: head and base must be different branches');
      const base = mergeBaseOf(ctx.git, headSha, baseSha);
      const baseMap = base === null ? new Map<string, string>() : treeOfCommit(ctx.git, base);
      const changes = diffPaths(baseMap, treeOfCommit(ctx.git, headSha));
      if (changes.length === 0) throw new GqlError('createPullRequest: head and base have no differences');
      const number = repo.nextPull;
      repo.nextPull += 1;
      const stamp = nowIso();
      const pull: Pull = {
        id: number,
        number,
        title,
        body: asString(input.body) ?? '',
        state: 'open',
        head: { ref: headRef, sha: headSha },
        base: { ref: baseRef, sha: baseSha },
        merged: false,
        mergeCommitSha: null,
        changedPaths: changes,
        user: ctx.login,
        createdAt: stamp,
        updatedAt: stamp,
      };
      repo.pulls.set(number, pull);
      return {
        __typename: 'CreatePullRequestPayload',
        $pullRequest: pullValue(repo, pull),
        $clientMutationId: clientMutationId,
      } as Obj;
    }
    case 'mergePullRequest': {
      const decoded = decodeGlobalId(input.pullRequestId);
      const repo = decoded !== null && decoded.kind === 'PullRequest' ? findRepoById(ctx.store, decoded.repoId) : undefined;
      const pull = repo?.pulls.get(decoded?.number ?? -1);
      if (repo === undefined || pull === undefined) throw new GqlError('mergePullRequest: pull request not found');
      if (pull.state === 'merged') throw new GqlError('mergePullRequest: pull request already merged');
      if (pull.state === 'closed') throw new GqlError('mergePullRequest: pull request is closed');
      const { headSha, baseSha } = liveTips(repo, pull);
      if (headSha === baseSha) throw new GqlError('mergePullRequest: nothing to merge');
      const conflictPath = findConflictPath(ctx.git, baseSha, headSha);
      if (conflictPath !== null) throw new GqlError(`mergePullRequest: merge conflict in ${conflictPath}`);
      const sha = squashMerge(ctx, repo, pull);
      pull.state = 'merged';
      pull.merged = true;
      pull.mergeCommitSha = sha;
      pull.updatedAt = nowIso();
      return {
        __typename: 'MergePullRequestPayload',
        $pullRequest: pullValue(repo, pull),
        $clientMutationId: clientMutationId,
      } as Obj;
    }
    case 'addComment': {
      const decoded = decodeGlobalId(input.subjectId);
      const repo = decoded !== null && decoded.kind === 'Issue' ? findRepoById(ctx.store, decoded.repoId) : undefined;
      const issue = repo?.issues.get(decoded?.number ?? -1);
      if (repo === undefined || issue === undefined) throw new GqlError('addComment: subject not found');
      const body = asString(input.body);
      if (body === null || body === '') throw new GqlError('addComment: body is required');
      const id = repo.nextComment;
      repo.nextComment += 1;
      const stamp = nowIso();
      issue.comments.set(id, { id, body, user: ctx.login, createdAt: stamp, updatedAt: stamp });
      issue.updatedAt = stamp;
      const node = {
        __typename: 'IssueComment',
        $repo: repo,
        $issue: issue,
        $commentId: id,
        $body: body,
        $user: ctx.login,
        $createdAt: stamp,
        $updatedAt: stamp,
      } as Obj;
      return {
        __typename: 'AddCommentPayload',
        $commentEdge: { __typename: 'IssueCommentEdge', $node: node, $cursor: encodeCursor(0) } as Obj,
        $clientMutationId: clientMutationId,
      } as Obj;
    }
    default:
      throw new GqlError(`Cannot query field "${field}" on type "Mutation".`);
  }
}

function resolveField(typeName: string, obj: Obj, field: string, args: Record<string, unknown>, ctx: ExecCtx): unknown {
  if (field === '__typename') return typeName;
  switch (typeName) {
    case 'Query':
      return resolveQueryField(field, args, ctx);
    case 'Mutation':
      return resolveMutationField(field, args, ctx);
    case 'Repository':
      return resolveRepositoryField(obj, field, args, ctx);
    case 'Issue':
      return resolveIssueField(obj, field, args, ctx);
    case 'PullRequest':
      return resolvePullField(obj, field, args, ctx);
    case 'User': {
      if (field === 'login') return obj.$login ?? '';
      if (field === 'id') return `U_${String(obj.$id ?? 0)}`;
      if (field === 'databaseId') return obj.$id ?? 0;
      if (field === 'url') return `https://github.com/${String(obj.$login ?? '')}`;
      throw new GqlError(`Cannot query field "${field}" on type "User".`);
    }
    case 'Ref': {
      if (field === 'name') return obj.$name ?? '';
      if (field === 'prefix') return obj.$prefix ?? 'refs/heads/';
      throw new GqlError(`Cannot query field "${field}" on type "Ref".`);
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return obj.$hasNextPage ?? false;
      if (field === 'hasPreviousPage') return obj.$hasPreviousPage ?? false;
      if (field === 'startCursor') return obj.$startCursor ?? null;
      if (field === 'endCursor') return obj.$endCursor ?? null;
      throw new GqlError(`Cannot query field "${field}" on type "PageInfo".`);
    }
    case '__Type': {
      if (field === 'name') return obj.$name ?? null;
      if (field === 'kind') return obj.$kind ?? null;
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = obj.$fields as string[] | undefined;
        if (fields === undefined || obj.$kind !== 'OBJECT') return null;
        return fields.map((name) => ({ __typename: '__Field', $name: name }) as Obj);
      }
      if (field === 'enumValues') {
        const values = obj.$enumValues as string[] | null | undefined;
        if (values === null || values === undefined || obj.$kind !== 'ENUM') return null;
        return values.map((name) => ({ __typename: '__EnumValue', $name: name }) as Obj);
      }
      throw new GqlError(`Cannot query field "${field}" on type "__Type".`);
    }
    case '__Field': {
      if (field === 'name') return obj.$name ?? '';
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return { __typename: '__Type', $name: 'String', $kind: 'SCALAR', $fields: [], $enumValues: null } as Obj;
      throw new GqlError(`Cannot query field "${field}" on type "__Field".`);
    }
    case '__EnumValue': {
      if (field === 'name') return obj.$name ?? '';
      if (field === 'description') return null;
      throw new GqlError(`Cannot query field "${field}" on type "__EnumValue".`);
    }
    case '__Schema': {
      if (field === 'queryType') return { __typename: '__Type', $name: 'Query', $kind: 'OBJECT', $fields: TYPE_DEFS.Query?.fields ?? [], $enumValues: null } as Obj;
      if (field === 'mutationType') return { __typename: '__Type', $name: 'Mutation', $kind: 'OBJECT', $fields: TYPE_DEFS.Mutation?.fields ?? [], $enumValues: null } as Obj;
      if (field === 'subscriptionType') return null;
      if (field === 'description') return null;
      if (field === 'types') {
        return Object.keys(TYPE_DEFS).map((name) => typeInfoValue(name)).filter((entry) => entry !== null);
      }
      if (field === 'directives') return [];
      throw new GqlError(`Cannot query field "${field}" on type "__Schema".`);
    }
    case 'PullRequestChangedFile': {
      if (field === 'path') return obj.$path ?? '';
      throw new GqlError(`Cannot query field "${field}" on type "PullRequestChangedFile".`);
    }
    case 'Label': {
      if (field === 'id') return `L_${String(obj.$name ?? '')}`;
      if (field === 'name') return obj.$name ?? '';
      if (field === 'color') return obj.$color ?? 'ededed';
      if (field === 'description') return obj.$description ?? '';
      throw new GqlError(`Cannot query field "${field}" on type "Label".`);
    }
    case 'IssueComment': {
      if (field === 'id') {
        const repo = obj.$repo as Repo;
        const issue = obj.$issue as Issue;
        return commentGlobalId(repo, issue.number, Number(obj.$commentId ?? 0));
      }
      if (field === 'body') return obj.$body ?? '';
      if (field === 'author') return userValue(ctx.store, String(obj.$user ?? ''));
      if (field === 'createdAt') return obj.$createdAt ?? '';
      if (field === 'updatedAt') return obj.$updatedAt ?? '';
      throw new GqlError(`Cannot query field "${field}" on type "IssueComment".`);
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return obj.$issue ?? null;
      if (field === 'clientMutationId') return obj.$clientMutationId ?? null;
      throw new GqlError(`Cannot query field "${field}" on type "${typeName}".`);
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return obj.$pullRequest ?? null;
      if (field === 'clientMutationId') return obj.$clientMutationId ?? null;
      throw new GqlError(`Cannot query field "${field}" on type "${typeName}".`);
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return obj.$commentEdge ?? null;
      if (field === 'clientMutationId') return obj.$clientMutationId ?? null;
      throw new GqlError(`Cannot query field "${field}" on type "${typeName}".`);
    }
    default: {
      if (
        typeName.endsWith('Connection') ||
        typeName.endsWith('Edge')
      ) {
        if (typeName.endsWith('Edge')) {
          if (field === 'node') return obj.$node ?? null;
          if (field === 'cursor') return obj.$cursor ?? null;
          throw new GqlError(`Cannot query field "${field}" on type "${typeName}".`);
        }
        return resolveConnectionField(obj, field, ctx);
      }
      throw new GqlError(`Cannot query field "${field}" on type "${typeName}".`);
    }
  }
}

// --- projection -------------------------------------------------------------

function projectValue(raw: unknown, selections: SelectionNode[], ctx: ExecCtx): unknown {
  if (Array.isArray(raw)) return raw.map((entry) => projectValue(entry, selections, ctx));
  if (isRecord(raw) && typeof raw.__typename === 'string') {
    return projectSelectionSet(raw.__typename, raw as Obj, selections, ctx);
  }
  return raw;
}

function projectSelectionSet(typeName: string, obj: Obj, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'field') {
      const args = resolveArgs(selection, ctx.variables);
      let raw: unknown;
      try {
        raw = resolveField(typeName, obj, selection.name, args, ctx);
      } catch (err) {
        if (err instanceof GqlError) {
          ctx.errors.push({ message: err.message });
          out[selection.alias] = null;
          continue;
        }
        throw err;
      }
      if (selection.selections.length === 0) {
        out[selection.alias] = raw;
      } else if (raw === null || raw === undefined) {
        out[selection.alias] = null;
      } else {
        out[selection.alias] = projectValue(raw, selection.selections, ctx);
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}".` });
        continue;
      }
      if (fragment.typeCondition !== typeName) continue;
      Object.assign(out, projectSelectionSet(typeName, obj, fragment.selections, ctx));
      continue;
    }
    // Inline fragment.
    if (selection.typeCondition === null || selection.typeCondition === typeName) {
      Object.assign(out, projectSelectionSet(typeName, obj, selection.selections, ctx));
    }
  }
  return out;
}

// --- one operation ----------------------------------------------------------

interface OperationResult {
  data: Record<string, unknown> | null;
  errors?: GqlErrorEntry[];
}

function executeOperation(
  doc: DocumentNode,
  operation: OperationNode,
  variables: Record<string, unknown>,
  store: Store,
  git: GitStore,
  login: string,
): OperationResult {
  const resolved: Record<string, unknown> = { ...variables };
  for (const def of operation.varDefs) {
    if (resolved[def.name] === undefined && def.defaultValue !== null) {
      resolved[def.name] = resolveValue(def.defaultValue, variables);
    }
  }
  const ctx: ExecCtx = {
    store,
    git,
    login,
    fragments: doc.fragments,
    variables: resolved,
    errors: [],
  };
  const rootType = operation.opType === 'mutation' ? 'Mutation' : 'Query';
  const root: Obj = { __typename: rootType };
  let data: Record<string, unknown> | null;
  try {
    data = projectSelectionSet(rootType, root, operation.selections, ctx);
  } catch (err) {
    if (err instanceof GqlError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    throw err;
  }
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

function runOperationBody(
  entry: unknown,
  store: Store,
  git: GitStore,
  login: string,
): OperationResult {
  if (!isRecord(entry) || typeof entry.query !== 'string' || entry.query.trim() === '') {
    return { data: null, errors: [{ message: 'No query provided.' }] };
  }
  let doc: DocumentNode;
  try {
    doc = new Parser(entry.query).parseDocument();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'GraphQL parse error';
    return { data: null, errors: [{ message }] };
  }
  const variables = isRecord(entry.variables) ? entry.variables : {};
  const operationName = typeof entry.operationName === 'string' ? entry.operationName : null;
  let operation: OperationNode | undefined;
  if (operationName !== null) {
    operation = doc.operations.find((candidate) => candidate.name === operationName);
    if (operation === undefined) {
      return { data: null, errors: [{ message: `Unknown operation named "${operationName}".` }] };
    }
  } else if (doc.operations.length === 1) {
    operation = doc.operations[0];
  } else {
    return { data: null, errors: [{ message: 'Must provide operation name if query contains multiple operations.' }] };
  }
  return executeOperation(doc, operation, variables, store, git, login);
}

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

export function mountGraphQL(ctx: RouterContext): RouteHandler {
  return async (req, res, pathname, method) => {
    if (pathname !== '/api/graphql') return false;
    if (method !== 'POST') return false;

    const login = authViewer(req, ctx.store);
    if (login === null) {
      jsonError(res, 401, 'Requires authentication');
      return true;
    }

    let body: unknown;
    try {
      body = await parseJsonBody(req);
    } catch (err) {
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

    if (Array.isArray(body)) {
      // GitHub operation batching: one envelope per operation, in order.
      const results: OperationResult[] = [];
      for (const entry of body) results.push(runOperationBody(entry, ctx.store, ctx.git, login));
      sendJson(res, 200, results);
      return true;
    }
    sendJson(res, 200, runOperationBody(body, ctx.store, ctx.git, login));
    return true;
  };
}
