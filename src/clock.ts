// Deterministic clock for the forge.
//
// The trial replays live and replay runs byte-identically, so no request path may
// read the wall clock or Math.random. This module reads the clock exactly once,
// at boot (module load): MAKEFUN_TRIAL_NOW when the harness sets it, otherwise
// one Date.now() call. Every later call returns the previous value + 1 ms, so
// timestamps are monotonic and fully deterministic under a fixed trial seed.
//
// Rule: import { nowMs, nowIso } from './clock.ts' anywhere a timestamp is
// needed; never call Date.now() / new Date() with no argument in request code.
// (new Date(ms) with an explicit ms, as nowIso does, is fine.)

const BOOT_MS: number = (() => {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  if (raw !== undefined && raw !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.trunc(parsed);
  }
  return Date.now();
})();

let currentMs = BOOT_MS;

/** The next deterministic millisecond: boot value first, then +1 ms per call. */
export function nowMs(): number {
  const value = currentMs;
  currentMs += 1;
  return value;
}

// The ISO prefix of the current second ("2026-11-18T12:00:00."), rebuilt only
// when the second changes: toISOString() is the slowest part of stamping a
// record, and the date/time fields are constant within a second, so the
// millisecond digits are the only part that moves. Output is byte-identical
// to new Date(ms).toISOString() (the prefix is sliced from a real
// toISOString() of that second, and the fraction is always 3 digits).
let cachedSecond = -1;
let cachedPrefix = '';

/** ISO-8601 UTC timestamp for the next deterministic millisecond. */
export function nowIso(): string {
  const ms = nowMs();
  const second = Math.floor(ms / 1000);
  if (second !== cachedSecond) {
    cachedSecond = second;
    cachedPrefix = new Date(second * 1000).toISOString().slice(0, 19) + '.';
  }
  return `${cachedPrefix}${String(ms % 1000).padStart(3, '0')}Z`;
}

/** The boot millisecond (for tests only; does not advance the clock). */
export function bootMs(): number {
  return BOOT_MS;
}
