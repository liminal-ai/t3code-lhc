import { describe, expect, it } from "vite-plus/test";
import {
  applyMention,
  draftWakes,
  mentionCandidates,
  mentionQueryAt,
  mergeMessages,
  parseRecipients,
  recipientsStorageKey,
  serializeRecipients,
  workingMembers,
  readMarkersAt,
  resolveRoundtableGate,
  shouldRedirectRoundtableRoute,
  shouldShowRoundtableSection,
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

  it("unions checked default recipients with the tags; @all still wakes everyone", () => {
    const ids = (text: string, checked: string[]) =>
      draftWakes(text, members, new Set(checked)).map((m) => m.id);
    expect(ids("no tags", ["sable"])).toEqual(["sable"]);
    expect(ids("@flint look", ["sable"])).toEqual(["sable", "flint"]);
    expect(ids("@sable look", ["sable"])).toEqual(["sable"]);
    expect(ids("plain", [])).toEqual([]);
    expect(ids("@all", ["sable"])).toEqual(["sable", "flint"]);
    expect(wakePreviewLabel("plain", members, new Set(["sable", "flint"]))).toBe(
      "Wakes everyone: Sable, Flint",
    );
    expect(wakePreviewLabel("plain", members, new Set(["flint"]))).toBe("Wakes Flint");
  });

  it("parses stored recipients, dropping unknown ids and bad JSON, and round-trips", () => {
    expect([...parseRecipients('["flint","reed"]', members)]).toEqual(["flint"]);
    expect([...parseRecipients("nope", members)]).toEqual([]);
    expect([...parseRecipients(null, members)]).toEqual([]);
    expect([...parseRecipients('{"a":1}', members)]).toEqual([]);
    expect(parseRecipients(serializeRecipients(new Set(["sable"])), members)).toEqual(
      new Set(["sable"]),
    );
    expect(recipientsStorageKey("spec-group")).toBe("t3code:roundtable:spec-group:recipients");
  });

  it("lists working members from the console activity", () => {
    expect(
      workingMembers([
        { ...members[0]!, activity: { state: "idle" } },
        { ...members[1]!, activity: { state: "working", wakeSeq: 1, since: "t" } },
        { id: "x", label: "X" },
      ]).map((m) => m.id),
    ).toEqual(["flint"]);
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

describe("roundtable gate (roundtableEnabled, alpha)", () => {
  it("is off by default: no sidebar section, the route redirects home", () => {
    const gate = resolveRoundtableGate({
      primarySettingsAvailable: true,
      settings: { roundtableEnabled: false },
    });
    expect(gate).toBe("disabled");
    expect(shouldShowRoundtableSection(gate)).toBe(false);
    expect(shouldRedirectRoundtableRoute(gate)).toBe(true);
  });

  it("is on when the setting is on: section shown, route stays", () => {
    const gate = resolveRoundtableGate({
      primarySettingsAvailable: true,
      settings: { roundtableEnabled: true },
    });
    expect(gate).toBe("enabled");
    expect(shouldShowRoundtableSection(gate)).toBe(true);
    expect(shouldRedirectRoundtableRoute(gate)).toBe(false);
  });

  it("waits for settings to hydrate before either showing or redirecting", () => {
    for (const settings of [null, undefined]) {
      const gate = resolveRoundtableGate({ primarySettingsAvailable: true, settings });
      expect(gate).toBe("pending");
      expect(shouldShowRoundtableSection(gate)).toBe(false);
      expect(shouldRedirectRoundtableRoute(gate)).toBe(false);
    }
  });

  it("is off without a primary server to proxy the console", () => {
    const gate = resolveRoundtableGate({
      primarySettingsAvailable: false,
      settings: { roundtableEnabled: true },
    });
    expect(gate).toBe("disabled");
    expect(shouldRedirectRoundtableRoute(gate)).toBe(true);
  });
});
