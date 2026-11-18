// Packfile encode/decode from scratch (node:zlib + node:crypto only).
//
// Implements the git pack format version 2:
//   header "PACK" + uint32 version + uint32 count, then one entry per object,
//   then a 20-byte trailer holding SHA-1 over everything before it.
// An entry is a type/size varint header, an optional delta base, and one
// raw zlib-deflate stream. Object types: commit (1), tree (2), blob (3),
// tag (4); delta types: OFS_DELTA (6, base by negative entry offset) and
// REF_DELTA (7, base by object id). No git binary is used at runtime.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

const HEX40 = /^[0-9a-f]{40}$/;

export function isObjectId(value: string): boolean {
  return HEX40.test(value);
}

/** git's object id: SHA-1 over `<type> <size>\0` + the object's bytes. */
export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const hash = createHash('sha1');
  hash.update(`${type} ${body.length}\0`, 'utf8');
  hash.update(body);
  return hash.digest('hex');
}

// ---------------------------------------------------------------------------------------------
// delta format
// ---------------------------------------------------------------------------------------------

/** Encode an unsigned varint the way git's delta format uses it (7 bits per byte, little-endian). */
function encodeDeltaVarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest = Math.floor(rest / 128);
    if (rest > 0) byte |= 0x80;
    bytes.push(byte);
  } while (rest > 0);
  return Buffer.from(bytes);
}

function decodeDeltaVarint(buffer: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let offset = start;
  for (;;) {
    if (offset >= buffer.length) throw new Error('delta size varint is truncated');
    const byte = buffer[offset++];
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (!(byte & 0x80)) break;
    if (shift > 56) throw new Error('delta size varint is too long');
  }
  return { value, next: offset };
}

/**
 * Build a delta that turns `base` into `target`. Greedy longest-match search
 * over 4-byte anchors: copy runs of 4+ bytes, literal inserts for the rest.
 * The result always decodes to exactly `target`; when nothing matches it is
 * just the two size varints plus literal inserts.
 */
export function createDelta(base: Uint8Array, target: Uint8Array): Buffer {
  const baseBuf = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const targetBuf = Buffer.isBuffer(target) ? target : Buffer.from(target);
  // First occurrence in base of every 4-byte sequence (keyed by its LE uint32).
  const anchors = new Map<number, number>();
  for (let i = 0; i + 4 <= baseBuf.length; i += 1) {
    const key = baseBuf.readUInt32LE(i);
    if (!anchors.has(key)) anchors.set(key, i);
  }
  const ops: Buffer[] = [];
  let insertStart = 0;
  const flushInserts = (end: number): void => {
    let at = insertStart;
    while (at < end) {
      const chunk = Math.min(127, end - at);
      ops.push(Buffer.from([chunk]));
      ops.push(targetBuf.subarray(at, at + chunk));
      at += chunk;
    }
  };
  const emitCopy = (offset: number, size: number): void => {
    let opcode = 0x80;
    const extra: number[] = [];
    for (let bit = 0; bit < 4; bit += 1) {
      const byte = (offset >> (8 * bit)) & 0xff;
      if (byte !== 0) {
        opcode |= 1 << bit;
        extra.push(byte);
      }
    }
    for (let bit = 0; bit < 3; bit += 1) {
      const byte = (size >> (8 * bit)) & 0xff;
      if (byte !== 0) {
        opcode |= 1 << (4 + bit);
        extra.push(byte);
      }
    }
    ops.push(Buffer.from([opcode, ...extra]));
  };
  let pos = 0;
  while (pos < targetBuf.length) {
    let matchOffset = -1;
    let matchLength = 0;
    if (pos + 4 <= targetBuf.length) {
      const key = targetBuf.readUInt32LE(pos);
      const basePos = anchors.get(key);
      if (basePos !== undefined) {
        let len = 4;
        const maxLen = Math.min(0x10000, targetBuf.length - pos, baseBuf.length - basePos);
        while (len < maxLen && targetBuf[pos + len] === baseBuf[basePos + len]) len += 1;
        if (len >= 4) {
          matchOffset = basePos;
          matchLength = len;
        }
      }
    }
    if (matchLength >= 4) {
      flushInserts(pos);
      emitCopy(matchOffset, matchLength);
      pos += matchLength;
      insertStart = pos;
    } else {
      pos += 1;
    }
  }
  flushInserts(targetBuf.length);
  return Buffer.concat([encodeDeltaVarint(baseBuf.length), encodeDeltaVarint(targetBuf.length), ...ops]);
}

/** Apply a git delta to a base object's bytes; throws on any malformed stream. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuf = Buffer.isBuffer(base) ? base : Buffer.from(base);
  const deltaBuf = Buffer.isBuffer(delta) ? delta : Buffer.from(delta);
  const source = decodeDeltaVarint(deltaBuf, 0);
  const target = decodeDeltaVarint(deltaBuf, source.next);
  if (source.value !== baseBuf.length) {
    throw new Error(`delta expects a ${source.value}-byte base, got ${baseBuf.length}`);
  }
  const out = Buffer.allocUnsafe(target.value);
  let written = 0;
  let offset = target.next;
  while (offset < deltaBuf.length) {
    const op = deltaBuf[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuf.length) throw new Error('delta copy offset is truncated');
          copyOffset |= deltaBuf[offset++] << (8 * bit);
        }
      }
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuf.length) throw new Error('delta copy size is truncated');
          copySize |= deltaBuf[offset++] << (8 * (bit - 4));
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > baseBuf.length) throw new Error('delta copy runs past the base');
      if (written + copySize > target.value) throw new Error('delta writes past its target size');
      baseBuf.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (offset + literal > deltaBuf.length) throw new Error('delta insert is truncated');
      if (written + literal > target.value) throw new Error('delta writes past its target size');
      deltaBuf.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== target.value) throw new Error(`delta produced ${written} of ${target.value} bytes`);
  return out;
}

// ---------------------------------------------------------------------------------------------
// packfile write
// ---------------------------------------------------------------------------------------------

export interface PackEntryInput {
  readonly type: GitObjectType;
  readonly data: Uint8Array;
}

export interface EncodePackOptions {
  /** Try OFS_DELTA/REF_DELTA encoding (default true). Small objects are never delta-encoded. */
  readonly tryDelta?: boolean;
  /** Objects outside this pack usable as REF_DELTA bases (a thin pack). */
  readonly externalBases?: ReadonlyMap<string, GitObject>;
}

/** The type/size varint header of one pack entry. */
function writeEntryHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (typeCode << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** The OFS_DELTA base-offset varint: how far back from this entry its base sits. */
function writeOfsBase(distance: number): Buffer {
  const bytes: number[] = [distance & 0x7f];
  let rest = distance >> 7;
  while (rest > 0) {
    rest -= 1;
    bytes.unshift(0x80 | (rest & 0x7f));
    rest >>= 7;
  }
  return Buffer.from(bytes);
}

/** Smallest object worth attempting a delta against (bytes of raw content). */
const DELTA_MIN_SIZE = 64;
/** At most this many external REF_DELTA candidates are tried per object. */
const MAX_REF_CANDIDATES = 4;

/**
 * Encode a packfile version 2 from plain objects. Entries keep the caller's
 * order. An object is stored as an OFS_DELTA against the most recent earlier
 * entry of the same type (or as a REF_DELTA against a supplied external base)
 * only when the delta's deflated form is smaller than the plain form; every
 * other object is stored whole. The trailer is SHA-1 over all preceding bytes.
 */
export function encodePack(entries: readonly PackEntryInput[], options: EncodePackOptions = {}): Buffer {
  const tryDelta = options.tryDelta !== false;
  const list = entries.map((entry) => ({
    type: entry.type,
    data: Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data),
    oid: hashObject(entry.type, entry.data),
  }));
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  // Offset of each entry's first header byte, for OFS_DELTA bases.
  const entryOffsets: number[] = [];
  let cursor = 12;
  const lastOfType = new Map<GitObjectType, number>();
  const externalByType = new Map<GitObjectType, GitObject[]>();
  if (options.externalBases) {
    for (const base of options.externalBases.values()) {
      const bucket = externalByType.get(base.type);
      if (bucket) {
        if (bucket.length < MAX_REF_CANDIDATES) bucket.push(base);
      } else externalByType.set(base.type, [base]);
    }
  }
  for (let index = 0; index < list.length; index += 1) {
    const entry = list[index];
    entryOffsets.push(cursor);
    const plain = deflateSync(entry.data);
    let best: { bytes: Buffer; header: Buffer } | null = null;
    if (tryDelta && entry.data.length >= DELTA_MIN_SIZE) {
      const candidates: Array<{ delta: Buffer; header: Buffer }> = [];
      const prevIndex = lastOfType.get(entry.type);
      if (prevIndex !== undefined) {
        const base = list[prevIndex];
        const delta = createDelta(base.data, entry.data);
        const deflated = deflateSync(delta);
        if (deflated.length + 8 < plain.length) {
          candidates.push({
            delta: deflated,
            header: Buffer.concat([
              writeEntryHeader(6, delta.length),
              writeOfsBase(cursor - entryOffsets[prevIndex]),
            ]),
          });
        }
      }
      const externals = externalByType.get(entry.type) ?? [];
      for (const base of externals) {
        const baseOid = hashObject(base.type, base.data);
        if (baseOid === entry.oid) continue;
        const delta = createDelta(base.data, entry.data);
        const deflated = deflateSync(delta);
        if (deflated.length + 24 < plain.length) {
          candidates.push({
            delta: deflated,
            header: Buffer.concat([writeEntryHeader(7, delta.length), Buffer.from(baseOid, 'hex')]),
          });
          break;
        }
      }
      candidates.sort((a, b) => a.delta.length + a.header.length - (b.delta.length + b.header.length));
      const winner = candidates[0];
      if (winner) best = { bytes: winner.delta, header: winner.header };
    }
    if (best) {
      parts.push(best.header, best.bytes);
      cursor += best.header.length + best.bytes.length;
    } else {
      const entryHeader = writeEntryHeader(TYPE_CODE[entry.type], entry.data.length);
      parts.push(entryHeader, plain);
      cursor += entryHeader.length + plain.length;
    }
    lastOfType.set(entry.type, index);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

// ---------------------------------------------------------------------------------------------
// packfile read
// ---------------------------------------------------------------------------------------------

export interface DecodedPackEntry {
  readonly offset: number;
  readonly type: GitObjectType;
  readonly oid: string;
  readonly data: Buffer;
  readonly delta: { readonly kind: 'ofs' | 'ref'; readonly baseOid: string } | null;
}

export interface DecodedPack {
  readonly version: number;
  readonly declaredCount: number;
  readonly objects: Map<string, GitObject>;
  readonly entries: DecodedPackEntry[];
  readonly trailer: string;
  readonly checksumOk: boolean;
  readonly deltaCount: number;
  readonly byteLength: number;
}

function readEntryHeader(buffer: Buffer, start: number): { typeCode: number; size: number; next: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const typeCode = (byte >> 4) & 0x07;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 56) throw new Error('pack entry size varint is too long');
  }
  return { typeCode, size, next: offset };
}

function readOfsBase(buffer: Buffer, start: number): { distance: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { distance: value, next: offset };
}

/** Inflate one zlib stream starting at `offset`; returns its bytes and the offset past the stream. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate: ${(err as Error).message}`);
  }
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** SHA-1 of every pack byte before the 20-byte trailer. */
export function packChecksum(pack: Uint8Array): string {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 20) throw new Error('pack is shorter than its trailer');
  return createHash('sha1').update(buffer.subarray(0, buffer.length - 20)).digest('hex');
}

export function verifyPackChecksum(pack: Uint8Array): { ok: boolean; expected: string; actual: string } {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  const actual = buffer.subarray(buffer.length - 20).toString('hex');
  const expected = packChecksum(buffer);
  return { ok: actual === expected, expected, actual };
}

/**
 * Decode a packfile (version 2 or 3) and resolve every object, including
 * OFS_DELTA and REF_DELTA chains. `resolveBase` supplies a base object a thin
 * pack leaves out. Throws on a bad header, a bad trailer checksum, a truncated
 * stream, a size mismatch, or an unresolvable delta base.
 */
export function decodePack(
  pack: Uint8Array,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): DecodedPack {
  const buffer = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  if (buffer.length < 32) throw new Error(`pack is ${buffer.length} bytes, too short`);
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const trailer = buffer.subarray(trailerStart).toString('hex');
  const computedTrailer = createHash('sha1').update(buffer.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computedTrailer) throw new Error('pack trailer checksum does not match its bytes');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: GitObjectType;
    resolved?: Buffer;
    oid?: string;
  }
  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readEntryHeader(buffer, offset);
    offset = header.next;
    const entry: RawEntry = { offset: entryOffset, typeCode: header.typeCode, size: header.size, data: Buffer.alloc(0) };
    if (header.typeCode === 6) {
      const base = readOfsBase(buffer, offset);
      offset = base.next;
      if (base.distance <= 0 || base.distance > entryOffset) {
        throw new Error(`ofs-delta at ${entryOffset} names an invalid base distance ${base.distance}`);
      }
      entry.baseOffset = entryOffset - base.distance;
    } else if (header.typeCode === 7) {
      if (offset + 20 > trailerStart) throw new Error('ref-delta base id is truncated');
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[header.typeCode]) {
      throw new Error(`pack entry ${index} has unknown type code ${header.typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) {
      throw new Error(
        `pack entry at ${entryOffset} declares ${header.size} bytes but inflated to ${inflated.data.length}`,
      );
    }
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) {
    throw new Error(`pack has ${trailerStart - offset} stray bytes before its trailer`);
  }

  const entries: DecodedPackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) {
      return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    }
    if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = options.resolveBase?.(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} is neither in the pack nor supplied`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return { type, data, oid };
  };

  let deltaCount = 0;
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (entry.typeCode === 6 || entry.typeCode === 7) deltaCount += 1;
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
    entries.push({
      offset: entry.offset,
      type: resolved.type,
      oid: resolved.oid,
      data: entry.data,
      delta:
        entry.typeCode === 6
          ? { kind: 'ofs', baseOid: byOffset.get(entry.baseOffset!)?.oid ?? '' }
          : entry.typeCode === 7
            ? { kind: 'ref', baseOid: entry.baseOid! }
            : null,
    });
  }
  return {
    version,
    declaredCount,
    objects,
    entries,
    trailer,
    checksumOk: true,
    deltaCount,
    byteLength: buffer.length,
  };
}

// ---------------------------------------------------------------------------------------------
// pack index (v2, optional: the server never reads .idx files from disk)
// ---------------------------------------------------------------------------------------------

/** CRC-32 (IEEE) of a buffer, the checksum a v2 pack index stores per object. */
export function crc32(buffer: Uint8Array): number {
  let table = CRC_TABLE;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    CRC_TABLE = table;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

let CRC_TABLE: Uint32Array | null = null;

/**
 * Build a version 2 pack index (.idx) for a pack: magic + version + 256-entry
 * fanout + sorted object ids + CRC-32s + offsets + pack checksum + idx checksum.
 * `entries` are the pack's decoded entries (oid + offset); `pack` supplies the
 * trailer checksum. Only used when a caller wants an index on disk.
 */
export function buildPackIndex(entries: readonly DecodedPackEntry[], pack: Uint8Array): Buffer {
  const sorted = [...entries].sort((a, b) => (a.oid < b.oid ? -1 : a.oid > b.oid ? 1 : 0));
  const fanout = new Uint32Array(256);
  for (const entry of sorted) fanout[Number.parseInt(entry.oid.slice(0, 2), 16)] += 1;
  for (let i = 1; i < 256; i += 1) fanout[i] += fanout[i - 1];
  const parts: Buffer[] = [];
  const head = Buffer.allocUnsafe(8);
  head.writeUInt32BE(0xff744f63, 0);
  head.writeUInt32BE(2, 4);
  parts.push(head);
  const fanoutBuf = Buffer.allocUnsafe(256 * 4);
  for (let i = 0; i < 256; i += 1) fanoutBuf.writeUInt32BE(fanout[i], i * 4);
  parts.push(fanoutBuf);
  const ids = Buffer.allocUnsafe(sorted.length * 20);
  const crcs = Buffer.allocUnsafe(sorted.length * 4);
  const offsets = Buffer.allocUnsafe(sorted.length * 4);
  for (let i = 0; i < sorted.length; i += 1) {
    const entry = sorted[i];
    Buffer.from(entry.oid, 'hex').copy(ids, i * 20);
    crcs.writeUInt32BE(crc32(entry.data), i * 4);
    offsets.writeUInt32BE(entry.offset, i * 4);
  }
  parts.push(ids, crcs, offsets);
  const packBuf = Buffer.isBuffer(pack) ? pack : Buffer.from(pack);
  parts.push(packBuf.subarray(packBuf.length - 20));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}
