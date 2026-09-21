// Fork-only (LHC): the group chat page. Same transcript and router as the
// group's iMessage line, read through this server's console proxy.
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import ChatMarkdown from "~/components/ChatMarkdown";
import { LhcGroupComposer, LhcGroupTranscript } from "~/components/LhcGroupChat";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { SidebarInset } from "~/components/ui/sidebar";
import { Spinner } from "~/components/ui/spinner";
import { isElectron } from "../env";
import { useLhcGroupTranscript } from "../lhcGroups";

function GroupChatRouteView() {
  const { groupId } = Route.useParams();
  const state = useLhcGroupTranscript(groupId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickToBottom = useRef(true);

  const groupName = state.group?.name ?? groupId;
  useEffect(() => {
    document.title = `${groupName} · T3 Code`;
  }, [groupName]);

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

  const members = state.group?.members ?? [];
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col">
        <WorkspacePageHeader electron={isElectron} className="relative bg-background">
          <div className="flex min-w-0 flex-1 items-baseline gap-2 truncate">
            <h1 className="truncate text-sm font-medium">{state.group?.name ?? groupId}</h1>
            {members.length ? (
              <span className="truncate text-xs text-secondary-label">
                {members.map((m) => `${m.label} (@${m.id})`).join(", ")}
              </span>
            ) : null}
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
        <LhcGroupComposer members={members} onSend={state.send} disabled={!state.loaded} />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/groups/$groupId")({
  component: GroupChatRouteView,
});
