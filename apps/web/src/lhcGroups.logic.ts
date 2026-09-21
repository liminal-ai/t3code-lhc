// Fork-only (LHC): pure logic for the roundtable page (a console group line).
// The wake rule mirrors the console router: a member wakes when its key (with
// or without @) appears as a word, or when it is a checked default recipient;
// @all / @everyone / @both wake every member; untagged text with nothing
// checked wakes nobody. Autocomplete offers member keys and "all" after an @.

export type LhcMemberActivity =
  | { readonly state: "working"; readonly wakeSeq: number; readonly since: string }
  | { readonly state: "idle" };

export interface LhcGroupMember {
  readonly id: string;
  readonly label: string;
  readonly cursorSeq?: number;
  /** From the console's detail route; absent on the list route and older consoles. */
  readonly activity?: LhcMemberActivity;
}

export interface LhcGroupSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly members: ReadonlyArray<LhcGroupMember>;
  readonly channels: ReadonlyArray<string>;
}

export interface LhcGroupMessage {
  readonly seq: number;
  readonly senderId: string;
  readonly senderLabel: string;
  readonly text: string;
  readonly at: string;
}

export const OWNER_SENDER_ID = "lee";
const ALL_TAGS = ["all", "everyone", "both"] as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Members a draft would wake, in member order: tags in the text, unioned with the checked ids. */
export function draftWakes(
  text: string,
  members: ReadonlyArray<LhcGroupMember>,
  checked: ReadonlySet<string> = new Set(),
): ReadonlyArray<LhcGroupMember> {
  if (/(?<![\w@])@(?:all|everyone|both)\b/i.test(text)) return members;
  return members.filter(
    (member) =>
      checked.has(member.id) ||
      new RegExp(String.raw`(?<![\w@])@?${escapeRegExp(member.id)}\b`, "i").test(text),
  );
}

export function wakePreviewLabel(
  text: string,
  members: ReadonlyArray<LhcGroupMember>,
  checked: ReadonlySet<string> = new Set(),
): string {
  if (!text.trim()) return "";
  const wakes = draftWakes(text, members, checked);
  if (wakes.length === 0) return "Wakes nobody (untagged text enters the transcript only)";
  if (wakes.length === members.length && members.length > 1)
    return `Wakes everyone: ${wakes.map((m) => m.label).join(", ")}`;
  return `Wakes ${wakes.map((m) => m.label).join(", ")}`;
}

export interface MentionQuery {
  /** Offset of the `@` in the text. */
  readonly start: number;
  /** Text typed after the `@`, up to the caret. */
  readonly query: string;
}

/** The `@word` being typed at the caret, or null when the caret is not in one. */
export function mentionQueryAt(text: string, caret: number): MentionQuery | null {
  const before = text.slice(0, caret);
  const match = /(^|[^\w@])@([\w-]*)$/.exec(before);
  if (!match) return null;
  const query = match[2] ?? "";
  return { start: caret - query.length - 1, query };
}

export function mentionCandidates(
  members: ReadonlyArray<LhcGroupMember>,
  query: string,
): ReadonlyArray<{ key: string; label: string }> {
  const q = query.toLowerCase();
  const options = [
    ...members.map((m) => ({ key: m.id, label: m.label })),
    { key: ALL_TAGS[0], label: "everyone" },
  ];
  return options.filter((o) => o.key.toLowerCase().startsWith(q));
}

/** Replace the mention being typed with `@key ` and report the new caret. */
export function applyMention(
  text: string,
  mention: MentionQuery,
  key: string,
): { text: string; caret: number } {
  const insert = `@${key} `;
  const end = mention.start + 1 + mention.query.length;
  const next = `${text.slice(0, mention.start)}${insert}${text.slice(end)}`;
  return { text: next, caret: mention.start + insert.length };
}

/** Messages after `since`, merged onto a list, deduplicated by seq, in order. */
export function mergeMessages(
  current: ReadonlyArray<LhcGroupMessage>,
  incoming: ReadonlyArray<LhcGroupMessage>,
): ReadonlyArray<LhcGroupMessage> {
  if (incoming.length === 0) return current;
  const bySeq = new Map<number, LhcGroupMessage>();
  for (const m of current) bySeq.set(m.seq, m);
  for (const m of incoming) bySeq.set(m.seq, m);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function lastSeqOf(messages: ReadonlyArray<LhcGroupMessage>): number {
  return messages.length ? messages[messages.length - 1]!.seq : 0;
}

/** Members the console reports as working on a reply, in member order. */
export function workingMembers(
  members: ReadonlyArray<LhcGroupMember>,
): ReadonlyArray<LhcGroupMember> {
  return members.filter((member) => member.activity?.state === "working");
}

/** localStorage key for a roundtable's default recipients (checked member ids). */
export function recipientsStorageKey(groupId: string): string {
  return `t3code:roundtable:${groupId}:recipients`;
}

/** Parse a stored recipients value; unknown ids are dropped, bad JSON yields nothing. */
export function parseRecipients(
  raw: string | null | undefined,
  members: ReadonlyArray<LhcGroupMember>,
): ReadonlySet<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    const known = new Set(members.map((member) => member.id));
    return new Set(parsed.filter((id): id is string => typeof id === "string" && known.has(id)));
  } catch {
    return new Set();
  }
}

export function serializeRecipients(checked: ReadonlySet<string>): string {
  return JSON.stringify([...checked]);
}

/** Members whose cursor sits at `seq` (their "read to here" marker). */
export function readMarkersAt(
  members: ReadonlyArray<LhcGroupMember>,
  seq: number,
): ReadonlyArray<LhcGroupMember> {
  return members.filter((m) => m.cursorSeq === seq && seq > 0);
}
