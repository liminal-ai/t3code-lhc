import { describe, expect, it } from "vite-plus/test";
import {
  applyMention,
  draftWakes,
  mentionCandidates,
  mentionQueryAt,
  mergeMessages,
  readMarkersAt,
  wakePreviewLabel,
  type LhcGroupMessage,
} from "./lhcGroups.logic";

const members = [
  { id: "sable", label: "Sable", cursorSeq: 7 },
  { id: "flint", label: "Flint", cursorSeq: 5 },
];

describe("group wake rule (mirrors the console router)", () => {
  it("wakes tagged members, everyone on @all, nobody when untagged", () => {
    expect(draftWakes("@flint status?", members).map((m) => m.id)).toEqual(["flint"]);
    expect(draftWakes("Sable, Flint can you both respond", members).map((m) => m.id)).toEqual([
      "sable",
      "flint",
    ]);
    expect(draftWakes("@all hi", members)).toEqual(members);
    expect(draftWakes("@everyone hi", members)).toEqual(members);
    expect(draftWakes("plain note", members)).toEqual([]);
    expect(draftWakes("mail me@flint.dev", members)).toEqual([]);
    expect(draftWakes("flintlock", members)).toEqual([]);
  });

  it("labels the preview", () => {
    expect(wakePreviewLabel("", members)).toBe("");
    expect(wakePreviewLabel("hello", members)).toMatch(/^Wakes nobody/);
    expect(wakePreviewLabel("@flint go", members)).toBe("Wakes Flint");
    expect(wakePreviewLabel("@all go", members)).toBe("Wakes everyone: Sable, Flint");
  });
});

describe("@ autocomplete", () => {
  it("finds the mention being typed at the caret", () => {
    expect(mentionQueryAt("hi @fl", 6)).toEqual({ start: 3, query: "fl" });
    expect(mentionQueryAt("@", 1)).toEqual({ start: 0, query: "" });
    expect(mentionQueryAt("hi @flint ok", 12)).toBeNull();
    expect(mentionQueryAt("me@flint", 8)).toBeNull();
    expect(mentionQueryAt("hi @fl", 3)).toBeNull();
  });

  it("offers member keys and all, filtered by prefix", () => {
    expect(mentionCandidates(members, "").map((c) => c.key)).toEqual(["sable", "flint", "all"]);
    expect(mentionCandidates(members, "F").map((c) => c.key)).toEqual(["flint"]);
    expect(mentionCandidates(members, "a").map((c) => c.key)).toEqual(["all"]);
  });

  it("applies a pick in place and moves the caret past it", () => {
    expect(applyMention("hi @fl there", { start: 3, query: "fl" }, "flint")).toEqual({
      text: "hi @flint  there",
      caret: 10,
    });
  });
});

describe("transcript merge and markers", () => {
  const line = (seq: number, text = `m${seq}`): LhcGroupMessage => ({
    seq,
    senderId: "lee",
    senderLabel: "Lee",
    text,
    at: "2026-09-21T12:00:00.000Z",
  });
  it("merges by seq without duplicates, in order", () => {
    const merged = mergeMessages([line(1), line(2)], [line(2, "dup"), line(3)]);
    expect(merged.map((m) => [m.seq, m.text])).toEqual([
      [1, "m1"],
      [2, "dup"],
      [3, "m3"],
    ]);
    const same = [line(1)];
    expect(mergeMessages(same, [])).toBe(same);
  });
  it("places read markers at member cursors, never at seq 0", () => {
    expect(readMarkersAt(members, 7).map((m) => m.id)).toEqual(["sable"]);
    expect(readMarkersAt(members, 5).map((m) => m.id)).toEqual(["flint"]);
    expect(readMarkersAt(members, 6)).toEqual([]);
    expect(readMarkersAt([{ id: "x", label: "X", cursorSeq: 0 }], 0)).toEqual([]);
  });
});
