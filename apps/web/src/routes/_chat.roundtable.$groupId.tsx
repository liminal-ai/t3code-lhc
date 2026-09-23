// Fork-only (LHC): the roundtable page. Same transcript and router as the
// group's iMessage line, read through this server's console proxy.
// Alpha: while the `roundtableEnabled` server setting is off the page redirects home.
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import ChatMarkdown from "~/components/ChatMarkdown";
import {
  LhcGroupComposer,
  LhcGroupTranscript,
  LhcRoundtableMemberStrip,
} from "~/components/LhcGroupChat";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { isElectron } from "../env";
import { useLhcGroupTranscript } from "../lhcGroups";
import { markRoundtableSeen } from "../lhcRoundtableSeen";
import {
  parseRecipients,
  recipientsStorageKey,
  serializeRecipients,
  shouldRedirectRoundtableRoute,
} from "../lhcGroups.logic";
import { useRoundtableGate } from "~/components/LhcGroupsSection";

function readStoredRecipients(groupId: string): string | null {
  try {
    return window.localStorage.getItem(recipientsStorageKey(groupId));
  } catch {
    return null;
  }
}

function RoundtableRouteView() {
  const { groupId } = Route.useParams();
  const state = useLhcGroupTranscript(groupId);
  // Default recipients persist per roundtable per browser; unknown ids drop at parse time.
  const [storedRecipients, setStoredRecipients] = useState<{ groupId: string; raw: string | null }>(
    () => ({ groupId, raw: readStoredRecipients(groupId) }),
  );
  const stored =
    storedRecipients.groupId === groupId ? storedRecipients.raw : readStoredRecipients(groupId);
  const members = state.group?.members ?? [];
  const checked = parseRecipients(stored, members);
  const onCheckedChange = useCallback(
    (memberId: string, value: boolean) => {
      const next = new Set(parseRecipients(stored, members));
      if (value) next.add(memberId);
      else next.delete(memberId);
      const raw = serializeRecipients(next);
      try {
        window.localStorage.setItem(recipientsStorageKey(groupId), raw);
      } catch {
        // private mode or quota: the choice lives for this page only
      }
      setStoredRecipients({ groupId, raw });
    },
    [groupId, members, stored],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const groupName = state.group?.name ?? groupId;
  useEffect(() => {
    document.title = `${groupName} · T3 Code`;
  }, [groupName]);

  // The page has shown the lines: the sidebar row's unread state clears here.
  const shownSeq = state.messages.length ? state.messages[state.messages.length - 1]!.seq : 0;
  useEffect(() => {
    if (state.loaded && shownSeq > 0) markRoundtableSeen(groupId, shownSeq);
  }, [groupId, shownSeq, state.loaded]);

  // Follow new lines while the reader sits at the bottom; leave them alone otherwise.
  // Markdown renders after the lines mount, so the content's size, not the line
  // count, is what keeps the view pinned.
  const lineCount = state.messages.length;
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || lineCount === 0) return;
    const pin = () => {
      if (stickToBottom.current) element.scrollTop = element.scrollHeight;
    };
    pin();
    const observer = new ResizeObserver(pin);
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [lineCount]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <div className="flex min-w-0 flex-1 items-baseline gap-2 truncate">
            <h1 className="truncate text-sm font-medium">{state.group?.name ?? groupId}</h1>
            {members.length ? <LhcRoundtableMemberStrip members={members} /> : null}
          </div>
        </WorkspacePageHeader>
        <div
          ref={scrollRef}
          className="topbar-scroll-fade min-h-0 flex-1 overflow-y-auto"
          onScroll={(event) => {
            const el = event.currentTarget;
            stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          }}
        >
          {!state.loaded ? (
            <div className="flex items-center justify-center py-16">
              <Spinner />
            </div>
          ) : state.error && state.messages.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-destructive">{state.error}</div>
          ) : state.messages.length === 0 ? (
            <div className="px-6 py-12 text-center text-sm text-secondary-label">
              No messages yet. Tag a member to start.
            </div>
          ) : (
            <LhcGroupTranscript
              messages={state.messages}
              members={members}
              renderMarkdown={(text) => <ChatMarkdown text={text} cwd={undefined} />}
            />
          )}
        </div>
        {state.error && state.messages.length > 0 ? (
          <div className="px-6 py-1 text-xs text-destructive">{state.error}</div>
        ) : null}
        <LhcGroupComposer
          members={members}
          onSend={state.send}
          disabled={!state.loaded}
          checked={checked}
          onCheckedChange={onCheckedChange}
        />
      </div>
    </SidebarInset>
  );
}

/** Gate first, so a disabled Roundtable never starts the transcript poll. */
function RoundtableRoute() {
  const gate = useRoundtableGate();
  const navigate = useNavigate();
  const redirectHome = shouldRedirectRoundtableRoute(gate);
  useEffect(() => {
    if (redirectHome) void navigate({ to: "/", replace: true });
  }, [navigate, redirectHome]);
  return gate === "enabled" ? <RoundtableRouteView /> : null;
}

export const Route = createFileRoute("/_chat/roundtable/$groupId")({
  component: RoundtableRoute,
});
