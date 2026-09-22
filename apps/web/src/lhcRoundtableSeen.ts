// Fork-only (LHC): per-roundtable "last seen transcript seq", persisted per
// browser like the recipient checkboxes, with subscribers so the sidebar row
// clears the moment the page has shown the lines.
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
const cache = new Map<string, number>();

export function roundtableSeenKey(groupId: string): string {
  return `t3code:roundtable:${groupId}:seenSeq`;
}

export function readRoundtableSeenSeq(groupId: string): number {
  const cached = cache.get(groupId);
  if (cached !== undefined) return cached;
  let value = 0;
  try {
    const raw = window.localStorage.getItem(roundtableSeenKey(groupId));
    const parsed = raw === null ? 0 : Number(raw);
    value = Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
  } catch {
    value = 0;
  }
  cache.set(groupId, value);
  return value;
}

/** Monotonic: never moves the marker backwards. Returns the stored value. */
export function markRoundtableSeen(groupId: string, seq: number): number {
  const current = readRoundtableSeenSeq(groupId);
  if (!(seq > current)) return current;
  cache.set(groupId, seq);
  try {
    window.localStorage.setItem(roundtableSeenKey(groupId), String(seq));
  } catch {
    // private mode or quota: the in-memory value still serves this page
  }
  for (const listener of listeners) listener();
  return seq;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useRoundtableSeenSeq(groupId: string): number {
  return useSyncExternalStore(
    subscribe,
    () => readRoundtableSeenSeq(groupId),
    () => 0,
  );
}

/** Test seam. */
export function resetRoundtableSeenCache(): void {
  cache.clear();
}
