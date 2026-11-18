// Shared HTTP helpers for every module: JSON replies, request ids, body reading.
//
// Every reply carries a non-empty `X-GitHub-Request-Id` header (the protocol
// group checks it on every call), so sendJson sets it on every response
// unless the caller passes one explicitly. No Date.now()/Math.random() here:
// request ids are a seeded counter (deterministic under MAKEFUN_TRIAL_SEED).

import type { IncomingMessage, ServerResponse } from 'node:http';

const JSON_TYPE = 'application/json; charset=utf-8';

/** Default cap for a JSON request body (10 MiB). Git packfiles read their own stream. */
export const MAX_JSON_BODY_BYTES = 10 * 1024 * 1024;

// --- request ids ------------------------------------------------------------

function seedHash(seed: string): number {
  // FNV-1a 32-bit over the seed string; 0 when no seed is set.
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const SEED_HASH = seedHash(process.env.MAKEFUN_TRIAL_SEED ?? '');
let requestCounter = 0;

/**
 * A 16-hex-char request id: 8 chars of the (seeded) hash + 8 chars of a
 * per-process counter. Deterministic for a fixed seed and request order;
 * unique within a process (the counter never repeats).
 */
export function newRequestId(): string {
  requestCounter += 1;
  const high = (SEED_HASH ^ 0x9e3779b9) >>> 0;
  const low = requestCounter >>> 0;
  return high.toString(16).padStart(8, '0') + low.toString(16).padStart(8, '0');
}

// --- per-request parsed URL / path segments ---------------------------------
//
// app.ts and every module used to re-parse `req.url` (a WHATWG URL parse) and
// re-split the pathname on every request — up to three URL parses and two
// segment splits for one REST call. The URL and the pathname are fixed for a
// request, so parse them once and cache the result on the request object
// itself (a Symbol-keyed slot, gone with the request). Pure functions of the
// request line: the cached values are byte-identical to a fresh parse.

const URL_SLOT = Symbol('forge.requestUrl');
const SEGMENTS_SLOT = Symbol('forge.requestSegments');
const QUERY_SLOT = Symbol('forge.requestQuery');

interface RequestSlots {
  [URL_SLOT]?: URL;
  [SEGMENTS_SLOT]?: { path: string; segments: string[] };
  [QUERY_SLOT]?: URLSearchParams;
}

/** The request URL, parsed once per request (`/` when it does not parse). */
export function requestUrl(req: IncomingMessage): URL {
  const slots = req as unknown as RequestSlots;
  const cached = slots[URL_SLOT];
  if (cached !== undefined) return cached;
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    url = new URL('http://entry/');
  }
  slots[URL_SLOT] = url;
  return url;
}

/** Split a pathname into decoded segments, dropping empty pieces. */
export function splitPath(pathname: string): string[] {
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

/** The request pathname's segments, split once per request. */
export function requestSegments(req: IncomingMessage, pathname: string): string[] {
  const slots = req as unknown as RequestSlots;
  const cached = slots[SEGMENTS_SLOT];
  if (cached !== undefined && cached.path === pathname) return cached.segments;
  const segments = splitPath(pathname);
  slots[SEGMENTS_SLOT] = { path: pathname, segments };
  return segments;
}

/** The request's query parameters (empty when the URL has no query string). */
export function requestQuery(req: IncomingMessage): URLSearchParams {
  const slots = req as unknown as RequestSlots;
  const cached = slots[QUERY_SLOT];
  if (cached !== undefined) return cached;
  const params = requestUrl(req).searchParams;
  slots[QUERY_SLOT] = params;
  return params;
}

// --- replies ----------------------------------------------------------------

/**
 * Answer with a JSON body. Always sets content-type, content-length and a
 * non-empty X-GitHub-Request-Id (unless `headers` supplies one). Extra
 * `headers` (e.g. Link, x-oauth-scopes) go beside the JSON ones.
 */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId =
    headers['x-github-request-id'] ?? headers['X-GitHub-Request-Id'] ?? newRequestId();
  const out: Record<string, string> = {
    'content-type': JSON_TYPE,
    'content-length': String(Buffer.byteLength(text)),
    'x-github-request-id': requestId,
    ...headers,
  };
  res.writeHead(status, out);
  res.end(text);
}

/** A GitHub-style error body: {"message": ...}. */
export function jsonError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

// --- request bodies ---------------------------------------------------------

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

export class MalformedJsonError extends Error {
  readonly status = 400;
  constructor() {
    super('Malformed JSON in request body');
    this.name = 'MalformedJsonError';
  }
}

/**
 * Read the whole request body as a Buffer. Rejects (BodyTooLargeError) past
 * `maxBytes`; the caller turns that into a 413. Never throws on an empty body.
 */
export function readBody(req: IncomingMessage, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > maxBytes) {
        done = true;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    req.on('error', (err) => {
      if (done) return;
      done = true;
      reject(err);
    });
  });
}

/**
 * Read and JSON-parse the request body. An empty body parses as `undefined`
 * (so GETs / body-less calls need no special case). Throws MalformedJsonError
 * (status 400) on malformed JSON and BodyTooLargeError past the cap.
 */
export async function parseJsonBody(req: IncomingMessage, maxBytes?: number): Promise<unknown> {
  const raw = await readBody(req, maxBytes);
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new MalformedJsonError();
  }
}
