// Git smart-HTTP handlers: protocol v2 upload-pack (ls-refs + fetch), protocol
// v0 upload-pack (fallback), and protocol v0 receive-pack (push), served under
// `/{owner}/{repo}.git`.
//
// Wire format notes (from the git protocol, implemented here from scratch):
// - pkt-line: 4 hex length bytes (payload + 4), "0000" flush, "0001" delim.
// - info/refs v0 starts with "# service=<name>" + flush, then "<oid> <ref>"
//   lines; the first line carries capabilities after a NUL. An empty repo
//   advertises "0000... capabilities^{}" instead of refs.
// - info/refs v2 (Git-Protocol: version=2) starts the same way, then the
//   pkt-line "version 2" and one capability line per capability.
// - v2 fetch answers in sections: "acknowledgments" (NAK / ACK + ready,
//   only when the client did NOT send "done"), "shallow-info" (shallow /
//   unshallow, no trailing newline on the lines), "packfile" (sideband band-1
//   pack bytes). Sections are separated by DELIM (0001); only the whole
//   response ends with FLUSH (0000).
// - receive-pack answers report-status inside sideband band 1 when the client
//   negotiated side-band-64k (it always does here): "unpack ok", then one
//   "ok <ref>" / "ng <ref> <reason>" line per command, in command order.
// - Fast-forward only: an update is accepted only when the current tip is an
//   ancestor of (or equal to) the new tip; otherwise the ref reports
//   "ng <ref> non-fast-forward" and does not move. A mixed push applies the
//   fast-forward refs and refuses the rest.
//
// No timestamps or randomness are used anywhere in the request path, so two
// identical requests produce identical bytes. Packs are cached per
// (repo, wants, depth, haves, shallow) and the cache is dropped for a repo
// whenever a push changes it.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { decodePack, encodePack, isObjectId, type GitObject } from './pack.ts';
import type { GitObjectType, GitStore } from './store-iface.ts';

export type { GitStore } from './store-iface.ts';

export const ZERO_OID = '0'.repeat(40);
export const DEFAULT_BRANCH = 'refs/heads/main';
const AGENT = 'forge/1.0';

/** (req, res, pathname, method) => true when this handler owns the request. */
export type GitRequestHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  method: string,
) => boolean;

export interface MountGitOptions {
  /** Bearer token to require; defaults to process.env.MAKEFUN_SHOP_TOKEN. */
  readonly token?: string;
}

// ---------------------------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------------------------

function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > 65516) throw new Error(`pkt-line payload is ${data.length} bytes, over the 65516-byte maximum`);
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
const DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

type Packet = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode a whole buffer of pkt-lines; `rest` is the bytes after the first flush (a raw pack). */
function decodePktLines(buffer: Buffer): { packets: Packet[]; rest: Buffer } {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      return { packets, rest: buffer.subarray(offset + 4) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: Buffer.alloc(0) };
}

/** Decode every pkt-line in a buffer (no flush expected); throws on malformed input. */
function decodeAllPktLines(buffer: Buffer): Packet[] {
  const packets: Packet[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error(`truncated pkt-line: ${buffer.length - offset} trailing byte(s)`);
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`invalid pkt-line length ${JSON.stringify(head)}`);
    const length = Number.parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || length > 65520) throw new Error(`invalid pkt-line length ${length}`);
    if (offset + length > buffer.length) throw new Error('truncated pkt-line payload');
    packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return packets;
}

function dataLines(packets: readonly Packet[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
  return lines;
}

// ---------------------------------------------------------------------------------------------
// minimal object parsing (headers only; the bytes themselves are never rewritten)
// ---------------------------------------------------------------------------------------------

interface CommitView {
  readonly tree: string;
  readonly parents: string[];
}

function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const headerText = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  for (const line of headerText.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
  }
  return { tree, parents };
}

interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

function parseTag(data: Buffer): { object: string; type: string } {
  const blank = data.indexOf('\n\n');
  const headerText = data.subarray(0, blank < 0 ? data.length : blank).toString('utf8');
  let object = '';
  let type = '';
  for (const line of headerText.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
  }
  return { object, type };
}

/** Follow annotated tags to the object they ultimately point at. */
function peelToCommit(store: GitStore, oid: string): string | undefined {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const obj = store.getObject(current);
    if (!obj) return undefined;
    if (obj.type === 'commit') return current;
    if (obj.type !== 'tag') return undefined;
    current = parseTag(obj.raw).object;
    if (!isObjectId(current)) return undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------------------------

interface ClosureOptions {
  /** Maximum commit generation distance from a root (undefined = unlimited). */
  readonly depth?: number;
  /** Commits whose parents the walker must not descend past (a shallow client's boundary). */
  readonly cutoffs?: ReadonlySet<string>;
}

interface Closure {
  /** Every object id in the closure (commits, trees, blobs, tags). */
  readonly objects: Set<string>;
  /** Included commits at distance depth-1: the new shallow boundary (empty without depth). */
  readonly boundary: Set<string>;
}

/**
 * Walk from `roots`, following commit parents, tag targets and tree entries.
 * Missing objects are skipped (the store is consistent in practice; a gap
 * must not take the server down). Tag targets inherit their tag's distance.
 */
function collectClosure(store: GitStore, roots: readonly string[], options: ClosureOptions = {}): Closure {
  const objects = new Set<string>();
  const boundary = new Set<string>();
  const depth = options.depth;
  const cutoffs = options.cutoffs;
  const queue: Array<{ oid: string; dist: number }> = [];
  for (const root of roots) if (isObjectId(root)) queue.push({ oid: root, dist: 0 });
  const seen = new Set<string>();
  while (queue.length) {
    const { oid, dist } = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(oid);
    if (!obj) continue;
    objects.add(oid);
    if (obj.type === 'commit') {
      if (depth !== undefined && dist === depth - 1) boundary.add(oid);
      const commit = parseCommit(obj.raw);
      if (isObjectId(commit.tree)) queue.push({ oid: commit.tree, dist });
      if (cutoffs?.has(oid)) continue;
      if (depth === undefined || dist + 1 < depth) {
        for (const parent of commit.parents) queue.push({ oid: parent, dist: dist + 1 });
      }
    } else if (obj.type === 'tag') {
      const target = parseTag(obj.raw).object;
      if (isObjectId(target)) queue.push({ oid: target, dist });
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.raw)) {
        if (entry.mode === '160000') continue;
        queue.push({ oid: entry.oid, dist });
      }
    }
  }
  return { objects, boundary };
}

/** True when `ancestor` is reachable from `descendant` through commit parents (or equal). */
function isAncestor(store: GitStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const start = peelToCommit(store, descendant);
  const target = peelToCommit(store, ancestor);
  if (!start || !target) return false;
  if (start === target) return true;
  const queue: string[] = [start];
  const seen = new Set<string>();
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.getObject(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.raw).parents) {
      if (parent === target) return true;
      queue.push(parent);
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    req.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > 128 * 1024 * 1024) {
        reject(new Error('request body over the 128 MiB limit'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks, length)));
    req.on('error', reject);
  });
}

/** Split a sideband payload stream into pkt-lines: first byte is the band (1 pack, 2 progress). */
function sidebandPackets(data: Buffer, chunkSize = 32768): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (data.length === 0) parts.push(pktLine(Buffer.from([1])));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// the handler
// ---------------------------------------------------------------------------------------------

const UPLOAD_CAPS_V0 = `side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT} symref=HEAD:${DEFAULT_BRANCH}`;
const RECEIVE_CAPS_V0 = `report-status side-band-64k delete-refs agent=${AGENT} symref=HEAD:${DEFAULT_BRANCH}`;

interface RepoRefs {
  readonly refs: Array<{ ref: string; oid: string }>;
  readonly mainOid: string | undefined;
}

function repoRefs(store: GitStore, repoKey: string): RepoRefs {
  const refs = store.listRefs(repoKey);
  return { refs, mainOid: store.getRef(repoKey, DEFAULT_BRANCH) };
}

/**
 * v0 ref advertisement lines. The first line carries the capabilities after
 * a NUL; peeled tags get a "<oid> <ref>^{}" line after their own line.
 */
function v0RefLines(store: GitStore, repoKey: string, capabilities: string): Buffer[] {
  const { refs, mainOid } = repoRefs(store, repoKey);
  const lines: Buffer[] = [];
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${capabilities}\n`));
    return lines;
  }
  let first = true;
  const emit = (text: string): void => {
    lines.push(pktLine(first ? `${text}\0${capabilities}\n` : `${text}\n`));
    first = false;
  };
  if (mainOid) emit(`${mainOid} HEAD`);
  for (const ref of refs) {
    emit(`${ref.oid} ${ref.ref}`);
    if (ref.ref.startsWith('refs/tags/')) {
      const peeled = peelToCommit(store, ref.oid);
      if (peeled && peeled !== ref.oid) lines.push(pktLine(`${peeled} ${ref.ref}^{}\n`));
    }
  }
  return lines;
}

function infoRefsV2Upload(): Buffer {
  return pktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow thin-pack ofs-delta\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

export function mountGit(store: GitStore, opts: MountGitOptions = {}): GitRequestHandler {
  const expectedToken = opts.token ?? process.env.MAKEFUN_SHOP_TOKEN ?? '';
  // Pack cache: key -> pack bytes. Dropped for a repo whenever a push changes it.
  const packCache = new Map<string, Buffer>();
  const dropPackCache = (repoKey: string): void => {
    for (const key of [...packCache.keys()]) {
      if (key.startsWith(`${repoKey}|`)) packCache.delete(key);
    }
    if (packCache.size > 128) {
      for (const key of [...packCache.keys()].slice(0, packCache.size - 128)) packCache.delete(key);
    }
  };

  const authorized = (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const presented = header.slice('Bearer '.length).trim();
    if (presented === '') return false;
    if (expectedToken !== '') return presented === expectedToken;
    return true;
  };

  const handle = async (req: IncomingMessage, res: ServerResponse, owner: string, repo: string): Promise<void> => {
    const repoKey = `${owner}/${repo}`;
    const url = new URL(req.url ?? '/', 'http://entry');
    const pathname = url.pathname;
    const method = req.method ?? 'GET';

    if (!authorized(req)) {
      sendJson(res, 401, { message: 'Requires authentication' });
      return;
    }
    if (!store.hasRepo(repoKey)) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    if (method === 'GET' && pathname.endsWith('/info/refs')) {
      const service = url.searchParams.get('service');
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 400, { message: 'Missing or unknown service parameter' });
        return;
      }
      const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2');
      if (wantsV2) {
        sendBuffer(res, 200, 'application/x-git-upload-pack-advertisement', infoRefsV2Upload());
        return;
      }
      const preamble = pktLine(`# service=${service}\n`);
      const lines = v0RefLines(store, repoKey, service === 'git-upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0);
      const contentType =
        service === 'git-upload-pack'
          ? 'application/x-git-upload-pack-advertisement'
          : 'application/x-git-receive-pack-advertisement';
      sendBuffer(res, 200, contentType, Buffer.concat([preamble, FLUSH, ...lines, FLUSH]));
      return;
    }

    if (method === 'POST' && pathname.endsWith('/git-upload-pack')) {
      const body = await readBody(req);
      const wantsV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      try {
        if (wantsV2) await handleUploadPackV2(store, repoKey, body, res, packCache);
        else await handleUploadPackV0(store, repoKey, body, res, packCache);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 400, { message: (err as Error).message });
      }
      return;
    }

    if (method === 'POST' && pathname.endsWith('/git-receive-pack')) {
      const body = await readBody(req);
      try {
        await handleReceivePack(store, repoKey, body, res);
        dropPackCache(repoKey);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 400, { message: (err as Error).message });
      }
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  };

  return (req, res, pathname, method) => {
    const match = /^\/([^/]+)\/([^/]+)\.git(\/info\/refs|\/git-upload-pack|\/git-receive-pack)$/.exec(pathname);
    if (!match) return false;
    void handle(req, res, match[1], match[2]).catch((err: unknown) => {
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: (err as Error).message });
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    });
    return true;
  };
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2: ls-refs + fetch
// ---------------------------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  /** The client sent "done": single-round negotiation, no acknowledgments. */
  done: boolean;
}

function parseV2Args(lines: readonly string[]): { command: string; args: string[] } {
  const commandLine = lines[0] ?? '';
  const match = /^command=([a-z-]+)\n?$/.exec(commandLine.trim());
  if (!match) throw new Error(`unknown protocol v2 command ${JSON.stringify(commandLine.trim().slice(0, 40))}`);
  return { command: match[1], args: lines.slice(1) };
}

function handleLsRefsV2(store: GitStore, repoKey: string, args: readonly string[], res: ServerResponse): void {
  const parsed: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') parsed.peel = true;
    else if (line === 'symrefs') parsed.symrefs = true;
    else if (line === 'unborn') parsed.unborn = true;
    else if (line.startsWith('ref-prefix ')) parsed.prefixes.push(line.slice('ref-prefix '.length));
    // agent= / object-format= lines are acknowledged and ignored.
  }
  const { refs, mainOid } = repoRefs(store, repoKey);
  const keep = (name: string): boolean =>
    parsed.prefixes.length === 0 || parsed.prefixes.some((prefix) => name.startsWith(prefix));
  const out: string[] = [];
  if (keep('HEAD')) {
    if (mainOid) {
      out.push(`${mainOid} HEAD${parsed.symrefs ? ` symref-target:${DEFAULT_BRANCH}` : ''}\n`);
    } else if (parsed.unborn) {
      out.push(`unborn HEAD${parsed.symrefs ? ` symref-target:${DEFAULT_BRANCH}` : ''}\n`);
    }
  }
  for (const ref of refs) {
    if (!keep(ref.ref)) continue;
    let line = `${ref.oid} ${ref.ref}`;
    if (parsed.peel && ref.ref.startsWith('refs/tags/')) {
      const peeled = peelToCommit(store, ref.oid);
      if (peeled && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', pktLines([...out, 'flush']));
}

/** Build (or reuse from cache) the pack for one fetch's object selection. */
function buildFetchPack(
  store: GitStore,
  repoKey: string,
  selection: ReadonlySet<string>,
  cacheKey: string,
  packCache: Map<string, Buffer>,
): Buffer {
  const cached = packCache.get(cacheKey);
  if (cached) return cached;
  const objects: Array<GitObject & { oid: string }> = [];
  for (const oid of selection) {
    const obj = store.getObject(oid);
    if (obj) objects.push({ type: obj.type as GitObjectType, data: obj.raw, oid });
  }
  // Deterministic order, grouped by type so delta encoding finds same-type bases.
  const typeOrder: Record<GitObjectType, number> = { commit: 0, tree: 1, blob: 2, tag: 3 };
  objects.sort((a, b) => typeOrder[a.type] - typeOrder[b.type] || (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const pack = encodePack(objects);
  packCache.set(cacheKey, pack);
  if (packCache.size > 128) {
    const first = packCache.keys().next().value;
    if (first !== undefined) packCache.delete(first);
  }
  return pack;
}

async function handleUploadPackV2(
  store: GitStore,
  repoKey: string,
  body: Buffer,
  res: ServerResponse,
  packCache: Map<string, Buffer>,
): Promise<void> {
  const packets = decodeAllPktLines(body);
  const lines = dataLines(packets);
  const { command, args } = parseV2Args(lines);
  if (command === 'ls-refs') {
    handleLsRefsV2(store, repoKey, args, res);
    return;
  }
  if (command !== 'fetch') throw new Error(`unsupported protocol v2 command ${command}`);

  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) fetchArgs.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8).trim());
    else if (line === 'done') fetchArgs.done = true;
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) fetchArgs.depth = n;
    }
    // thin-pack / no-progress / ofs-delta / filter / object-format / agent: noted, ignored.
  }
  const wants = [...new Set(fetchArgs.wants)].filter((oid) => isObjectId(oid) && store.getObject(oid));
  const haves = fetchArgs.haves.filter((oid) => isObjectId(oid));
  const oldShallow = fetchArgs.shallow.filter((oid) => isObjectId(oid));
  const clientHas = collectClosure(store, haves, { cutoffs: new Set(oldShallow) }).objects;
  const wanted = collectClosure(store, wants, { depth: fetchArgs.depth });
  const selection = new Set<string>();
  for (const oid of wanted.objects) if (!clientHas.has(oid)) selection.add(oid);
  const cacheKey = [
    repoKey,
    wants.slice().sort().join(','),
    `d=${fetchArgs.depth ?? ''}`,
    haves.slice().sort().join(','),
    oldShallow.slice().sort().join(','),
  ].join('|');
  const pack = buildFetchPack(store, repoKey, selection, cacheKey, packCache);

  // Acknowledgments: ACK every have the server can reach from the wants, else
  // NAK. The section is only sent when the client did NOT send "done"
  // (multi-round negotiation): with "done" a real git server goes straight to
  // the packfile section, and a real git client rejects an "acknowledgments"
  // section there. Sections are separated by DELIM; only the whole response
  // ends with FLUSH. Shallow lines carry no trailing newline, like git's.
  const common = haves.filter((oid) => wanted.objects.has(oid));
  const parts: Buffer[] = [];
  if (!fetchArgs.done) {
    parts.push(pktLine('acknowledgments\n'));
    if (common.length) {
      for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
      parts.push(pktLine('ready\n'));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    parts.push(DELIM);
  }
  const newShallow = [...wanted.boundary].sort();
  const unshallow = oldShallow.filter((oid) => wanted.objects.has(oid) && !wanted.boundary.has(oid)).sort();
  if (newShallow.length || unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}`));
    parts.push(DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPackets(pack));
  parts.push(FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0: want/have/done + sideband pack
// ---------------------------------------------------------------------------------------------

async function handleUploadPackV0(
  store: GitStore,
  repoKey: string,
  body: Buffer,
  res: ServerResponse,
  packCache: Map<string, Buffer>,
): Promise<void> {
  const packets = decodeAllPktLines(body);
  const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const raw of dataLines(packets)) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0];
      if (isObjectId(oid)) fetchArgs.wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) fetchArgs.haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) fetchArgs.shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) fetchArgs.depth = n;
    }
    // done / deepen-since / deepen-not: noted, ignored.
  }
  const wants = [...new Set(fetchArgs.wants)].filter((oid) => store.getObject(oid));
  const haves = fetchArgs.haves.filter((oid) => isObjectId(oid));
  const oldShallow = fetchArgs.shallow.filter((oid) => isObjectId(oid));
  const clientHas = collectClosure(store, haves, { cutoffs: new Set(oldShallow) }).objects;
  const wanted = collectClosure(store, wants, { depth: fetchArgs.depth });
  const selection = new Set<string>();
  for (const oid of wanted.objects) if (!clientHas.has(oid)) selection.add(oid);
  const cacheKey = [
    repoKey,
    `v0`,
    wants.slice().sort().join(','),
    `d=${fetchArgs.depth ?? ''}`,
    haves.slice().sort().join(','),
    oldShallow.slice().sort().join(','),
  ].join('|');
  const pack = buildFetchPack(store, repoKey, selection, cacheKey, packCache);

  const parts: Buffer[] = [];
  const common = haves.filter((oid) => wanted.objects.has(oid));
  if (common.length) {
    for (const oid of common) parts.push(pktLine(`ACK ${oid}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of [...wanted.boundary].sort()) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of oldShallow.filter((oid) => wanted.objects.has(oid) && !wanted.boundary.has(oid)).sort()) {
    parts.push(pktLine(`unshallow ${oid}\n`));
  }
  parts.push(sidebandPackets(pack));
  parts.push(FLUSH);
  sendBuffer(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(parts));
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0: command list + pack, per-ref fast-forward rules, report-status
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

async function handleReceivePack(store: GitStore, repoKey: string, body: Buffer, res: ServerResponse): Promise<void> {
  const { packets, rest: packBytes } = decodePktLines(body);
  const commands: PushCommand[] = [];
  for (const raw of dataLines(packets)) {
    const line = raw.replace(/\n$/, '');
    const nul = line.indexOf('\0');
    const text = nul >= 0 ? line.slice(0, nul) : line;
    const parts = text.split(' ');
    if (parts.length < 3) throw new Error(`bad receive-pack command ${JSON.stringify(text.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts;
    if (!isObjectId(oldOid) || !isObjectId(newOid)) throw new Error('receive-pack command has a bad object id');
    if (!ref.startsWith('refs/')) throw new Error(`receive-pack command has a bad ref ${JSON.stringify(ref)}`);
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('receive-pack needs at least one command');

  const report: Array<{ ref: string; ok: boolean; reason: string }> = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const decoded = decodePack(packBytes, {
        resolveBase: (oid) => {
          const obj = store.getObject(oid);
          return obj ? { type: obj.type as GitObjectType, data: obj.raw } : undefined;
        },
      });
      for (const obj of decoded.objects.values()) store.putObject(obj.type as GitObjectType, obj.data);
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message.slice(0, 200);
    }
  }
  if (unpackOk) {
    for (const command of commands) {
      const current = store.getRef(repoKey, command.ref);
      if (command.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          report.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
          report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          store.deleteRef(repoKey, command.ref);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
      } else if (command.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          report.push({ ref: command.ref, ok: false, reason: 'already exists' });
        } else if (!store.getObject(command.newOid)) {
          report.push({ ref: command.ref, ok: false, reason: 'missing object' });
        } else {
          store.setRef(repoKey, command.ref, command.newOid);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
      } else {
        // Update: fast-forward only.
        if (current === undefined) {
          report.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        } else if (command.oldOid !== current) {
          report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else if (command.newOid === current) {
          report.push({ ref: command.ref, ok: true, reason: '' });
        } else if (!store.getObject(command.newOid)) {
          report.push({ ref: command.ref, ok: false, reason: 'missing object' });
        } else if (!isAncestor(store, current, command.newOid)) {
          report.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        } else {
          store.setRef(repoKey, command.ref, command.newOid);
          report.push({ ref: command.ref, ok: true, reason: '' });
        }
      }
    }
  } else {
    for (const command of commands) report.push({ ref: command.ref, ok: false, reason: 'unpack error' });
  }

  const innerLines: Array<string | 'flush'> = [`unpack ${unpackOk ? 'ok' : unpackDetail}\n`];
  for (const entry of report) {
    innerLines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  // The report-status stream itself ends with a flush packet inside the
  // sideband: without it a real git client reads both lines and then reports
  // "the remote end hung up unexpectedly" waiting for the terminator.
  innerLines.push('flush');
  const inner = pktLines(innerLines);
  sendBuffer(res, 200, 'application/x-git-receive-pack-result', Buffer.concat([sidebandPackets(inner), FLUSH]));
}
