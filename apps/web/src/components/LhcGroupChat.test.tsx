import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { LhcGroupComposer, LhcGroupTranscript, LhcRoundtableMemberStrip } from "./LhcGroupChat";
import { LhcGroupsSectionView } from "./LhcGroupsSection";

const members = [
  { id: "sable", label: "Sable", cursorSeq: 3 },
  { id: "flint", label: "Flint", cursorSeq: 1 },
];
const transcript = [
  {
    seq: 1,
    senderId: "lee",
    senderLabel: "Lee",
    text: "@flint @sable hello",
    at: "2026-09-21T12:39:53.000Z",
  },
  {
    seq: 2,
    senderId: "sable",
    senderLabel: "Sable",
    text: "**Sable** here",
    at: "2026-09-21T12:40:03.000Z",
  },
  {
    seq: 3,
    senderId: "flint",
    senderLabel: "Flint",
    text: "Flint here",
    at: "2026-09-21T12:40:07.000Z",
  },
];

const working = { state: "working", wakeSeq: 4, since: "2026-09-21T12:41:00.000Z" } as const;
const idle = { state: "idle" } as const;
const noChecks = new Set<string>();

describe("roundtable page pieces", () => {
  it("renders a pending 'is working' row per working member after the lines, none when idle", () => {
    const html = renderToStaticMarkup(
      <LhcGroupTranscript
        messages={transcript}
        members={[
          { ...members[0]!, activity: working },
          { ...members[1]!, activity: idle },
        ]}
        renderMarkdown={(text) => <span>{text}</span>}
      />,
    );
    expect(html).toContain('data-testid="lhc-group-working-sable"');
    expect(html).toMatch(/lhc-group-working-sable"[^>]*role="status"/);
    expect(html).toContain("Sable is working");
    expect(html).not.toContain("lhc-group-working-flint");
    expect(html.indexOf('data-seq="3"')).toBeLessThan(html.indexOf("lhc-group-working-sable"));
    const quiet = renderToStaticMarkup(
      <LhcGroupTranscript
        messages={transcript}
        members={members}
        renderMarkdown={(text) => <span>{text}</span>}
      />,
    );
    expect(quiet).not.toContain("is working");
  });

  it("renders the member strip with a live dot only on working members", () => {
    const html = renderToStaticMarkup(
      <LhcRoundtableMemberStrip
        members={[
          { ...members[0]!, activity: idle },
          { ...members[1]!, activity: working },
        ]}
      />,
    );
    expect(html).toMatch(/lhc-roundtable-member-flint"[^>]*data-working="true"/);
    expect(html).not.toMatch(/lhc-roundtable-member-sable"[^>]*data-working/);
    expect(html).toContain("animate-status-pulse");
    expect(html.match(/animate-status-pulse/g)).toHaveLength(1);
  });

  it("renders one recipient checkbox per member, checked from the page's set, and the union preview", () => {
    const html = renderToStaticMarkup(
      <LhcGroupComposer
        members={members}
        onSend={async () => undefined}
        checked={new Set(["flint"])}
        onCheckedChange={() => {}}
      />,
    );
    expect(html).toContain('data-testid="lhc-recipient-sable"');
    expect(html).toContain('data-testid="lhc-recipient-flint"');
    expect(html).toMatch(/aria-checked="true"[^>]*lhc-recipient-flint"/);
    expect(html).toMatch(/aria-checked="false"[^>]*lhc-recipient-sable"/);
  });

  it("renders the transcript oldest-first with owner lines distinct and read markers at cursors", () => {
    const html = renderToStaticMarkup(
      <LhcGroupTranscript
        messages={transcript}
        members={members}
        renderMarkdown={(text) => <em data-md="">{text}</em>}
      />,
    );
    const order = [...html.matchAll(/data-seq="(\d+)" data-sender="([a-z]+)"/g)].map((m) => [
      m[1],
      m[2],
    ]);
    expect(order).toEqual([
      ["1", "lee"],
      ["2", "sable"],
      ["3", "flint"],
    ]);
    expect(html).toContain('items-end"');
    expect(html).toContain('<em data-md="">**Sable** here</em>');
    expect(html).not.toContain('<em data-md="">@flint @sable hello</em>');
    expect(html).toContain('data-testid="lhc-group-read-marker-3"');
    expect(html).toMatch(/lhc-group-read-marker-3"[^>]*>Sable read to here/);
    expect(html).toMatch(/lhc-group-read-marker-1"[^>]*>Flint read to here/);
  });

  it("renders the composer with member placeholder and an empty preview", () => {
    const html = renderToStaticMarkup(
      <LhcGroupComposer
        members={members}
        onSend={async () => undefined}
        checked={noChecks}
        onCheckedChange={() => {}}
      />,
    );
    expect(html).toContain('placeholder="@sable … or @all"');
    expect(html).toContain('data-testid="lhc-group-send"');
    expect(html).not.toContain("lhc-group-mention-menu");
  });

  it("roundtable rows: working pill, unread dot + bold, resting age", () => {
    const row = (id: string, working: string[], latestSeq: number, failed: string[] = []) => ({
      id,
      name: id,
      description: "d",
      members,
      channels: [] as string[],
      working,
      failed,
      latestSeq,
      latestAt: "2026-09-22T10:00:00.000Z",
    });
    const html = renderToStaticMarkup(
      <LhcGroupsSectionView
        groups={[
          row("busy", ["sable"], 9),
          row("fresh", [], 4),
          row("quiet", [], 4),
          row("broken", [], 4, ["flint"]),
        ]}
        activeGroupId={null}
        expanded
        onToggleExpanded={() => {}}
        onSelect={() => {}}
        seenSeqOf={(id) => (id === "quiet" ? 4 : 0)}
      />,
    );
    expect(html).toMatch(/lhc-group-row-busy"[^>]*data-working="true"/);
    expect(html).toContain('data-testid="lhc-group-working-busy"');
    expect(html).toContain("Sable working");
    expect(html).toContain("animate-status-pulse");
    expect(html).toMatch(/lhc-group-row-fresh"[^>]*data-unread="true"/);
    expect(html).toContain('data-testid="lhc-group-unread-fresh"');
    expect(html).not.toMatch(/lhc-group-row-quiet"[^>]*data-unread/);
    expect(html).not.toContain("lhc-group-unread-quiet");
    expect(html).not.toContain("lhc-group-working-quiet");
    expect(html).toMatch(/lhc-group-row-broken"[^>]*data-failed="true"/);
    expect(html).toContain('data-testid="lhc-group-failed-broken"');
    expect(html).toContain("Flint failed");
    expect(html).toContain("text-destructive");
    expect(html).not.toContain("lhc-group-failed-quiet");
  });

  it("renders the sidebar Roundtable section with one row per group and the active row marked", () => {
    const html = renderToStaticMarkup(
      <LhcGroupsSectionView
        groups={[
          {
            id: "spec-group",
            name: "spec-group",
            description: "d",
            members,
            channels: ["photon"],
          },
          { id: "other", name: "other", description: "d", members: [], channels: [] },
        ]}
        activeGroupId="spec-group"
        expanded
        onToggleExpanded={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(html).toContain("Roundtable (2)");
    expect(html).not.toContain("Groups (");
    expect(html).toContain('data-testid="lhc-group-row-spec-group"');
    expect(html).toContain('data-testid="lhc-group-row-other"');
    expect(html.match(/data-active="true"/g)).toHaveLength(1);
    expect(html.indexOf('data-active="true"')).toBeLessThan(html.indexOf("lhc-group-row-other"));
    expect(html).toContain("Sable · Flint");
    const collapsed = renderToStaticMarkup(
      <LhcGroupsSectionView
        groups={[{ id: "g", name: "g", description: "", members: [], channels: [] }]}
        activeGroupId={null}
        expanded={false}
        onToggleExpanded={() => {}}
        onSelect={() => {}}
      />,
    );
    expect(collapsed).not.toContain("lhc-group-row-g");
  });
});
