import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  markRoundtableSeen,
  readRoundtableSeenSeq,
  resetRoundtableSeenCache,
  roundtableSeenKey,
} from "./lhcRoundtableSeen";

const store = new Map<string, string>();
const fakeStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
};

describe("roundtable seen seq", () => {
  beforeEach(() => {
    store.clear();
    resetRoundtableSeenCache();
    (globalThis as { window?: unknown }).window = { localStorage: fakeStorage };
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it("reads 0 when unset or malformed, persists under the per-roundtable key, never moves backwards", () => {
    expect(readRoundtableSeenSeq("g")).toBe(0);
    store.set(roundtableSeenKey("h"), "nope");
    expect(readRoundtableSeenSeq("h")).toBe(0);
    expect(markRoundtableSeen("g", 7)).toBe(7);
    expect(store.get("t3code:roundtable:g:seenSeq")).toBe("7");
    expect(markRoundtableSeen("g", 3)).toBe(7);
    expect(readRoundtableSeenSeq("g")).toBe(7);
  });

  it("survives a storage failure in memory", () => {
    (globalThis as { window?: unknown }).window = {
      localStorage: {
        getItem: () => {
          throw new Error("denied");
        },
        setItem: () => {
          throw new Error("denied");
        },
      },
    };
    expect(readRoundtableSeenSeq("g")).toBe(0);
    expect(markRoundtableSeen("g", 2)).toBe(2);
    expect(readRoundtableSeenSeq("g")).toBe(2);
  });
});
