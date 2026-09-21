import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { LhcGroupComposer, LhcGroupTranscript } from "./LhcGroupChat";
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

describe("group chat page pieces", () => {
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
      <LhcGroupComposer members={members} onSend={async () => undefined} />,
    );
    expect(html).toContain('placeholder="@sable … or @all"');
    expect(html).toContain('data-testid="lhc-group-send"');
    expect(html).not.toContain("lhc-group-mention-menu");
  });

  it("renders the sidebar Groups section with one row per group and the active row marked", () => {
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
    expect(html).toContain("Groups (2)");
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
