// Fork-only (LHC): the Roundtable section of the LHC sidebar. Lists the console's
// group lines (proxied by this server); selecting one opens the group chat
// page. Collapse is component state: no client setting, no upstream touch.
import { ChevronRightIcon, UsersIcon } from "lucide-react";
import { memo, useState } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import type { LhcGroupSummary } from "../lhcGroups.logic";
import { useLhcGroups } from "../lhcGroups";
import { useRoundtableSeenSeq } from "../lhcRoundtableSeen";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { lhcRowSurfaceClassName, resolveLhcRoundtableRowStatus } from "./LhcSidebar.logic";
import { resolveThreadRowClassName } from "./Sidebar.logic";
import { ThreadStatusLabel } from "./ThreadStatusIndicators";
import { CircleXIcon } from "lucide-react";
import { WORKING_STATUS_PILL } from "./LhcGroupChat";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";

export function LhcGroupsSection() {
  const activeGroupId = useParams({
    strict: false,
    select: (params) => (params as { groupId?: string }).groupId ?? null,
  });
  const { groups } = useLhcGroups(activeGroupId !== null);
  const [expanded, setExpanded] = useState(true);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  // A stock server (no proxy) or a console with no groups: the section stays out of the way.
  if (!groups || groups.length === 0) return null;
  return (
    <LhcGroupsSectionView
      groups={groups}
      activeGroupId={activeGroupId}
      expanded={expanded}
      onToggleExpanded={() => setExpanded((value) => !value)}
      onSelect={(groupId) => {
        if (isMobile) setOpenMobile(false);
        void router.navigate({ to: "/roundtable/$groupId", params: { groupId } });
      }}
    />
  );
}

/** Presentation only, so it renders without router or data providers. */
export const LhcGroupsSectionView = memo(function LhcGroupsSectionView(props: {
  readonly groups: ReadonlyArray<LhcGroupSummary>;
  readonly activeGroupId: string | null;
  readonly expanded: boolean;
  readonly onToggleExpanded: () => void;
  readonly onSelect: (groupId: string) => void;
  /** Injected for tests; the live section reads the persisted seen seq per group. */
  readonly seenSeqOf?: ((groupId: string) => number) | undefined;
}) {
  const { groups, activeGroupId, expanded, onToggleExpanded, onSelect } = props;
  return (
    <SidebarGroup className="px-2 pt-1 pb-0" data-testid="lhc-groups-section">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Roundtable (${groups.length})`}
        data-testid="lhc-groups-header"
        className="mb-1 flex h-6 w-full cursor-pointer items-center gap-1 rounded-md pl-1.5 pr-1.5 text-left text-xs font-medium text-secondary-label hover:bg-foreground/5 hover:text-foreground"
        onClick={onToggleExpanded}
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <span className="truncate">Roundtable ({groups.length})</span>
      </button>
      {expanded ? (
        <SidebarMenu>
          <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 gap-0.5 overflow-hidden border-l-0 px-1 py-0 sm:mx-1 sm:px-1">
            {groups.map((group) => (
              <LhcGroupRow
                key={group.id}
                group={group}
                isActive={group.id === activeGroupId}
                onSelect={onSelect}
                seenSeqOf={props.seenSeqOf}
              />
            ))}
          </SidebarMenuSub>
        </SidebarMenu>
      ) : null}
    </SidebarGroup>
  );
});

function LhcGroupRow(props: {
  readonly group: LhcGroupSummary;
  readonly isActive: boolean;
  readonly onSelect: (groupId: string) => void;
  readonly seenSeqOf?: ((groupId: string) => number) | undefined;
}) {
  const { group, isActive, onSelect, seenSeqOf } = props;
  const storedSeenSeq = useRoundtableSeenSeq(group.id);
  const seenSeq = seenSeqOf ? seenSeqOf(group.id) : storedSeenSeq;
  const status = resolveLhcRoundtableRowStatus(group, isActive ? Number.MAX_SAFE_INTEGER : seenSeq);
  const working = status.working.length > 0;
  const failed = status.failed.length > 0;
  const tooltip = `${group.name}: ${group.members.map((m) => m.label).join(", ")}${
    working ? ` · ${status.working.join(", ")} working` : ""
  }${failed ? ` · ${status.failed.join(", ")} failed` : ""}`;
  return (
    <SidebarMenuSubItem className="w-full" data-testid={`lhc-group-${group.id}`}>
      <SidebarMenuSubButton
        size="sm"
        isActive={isActive}
        data-testid={`lhc-group-row-${group.id}`}
        data-working={working ? "true" : undefined}
        data-failed={failed ? "true" : undefined}
        data-unread={status.isUnread ? "true" : undefined}
        className={`${resolveThreadRowClassName({ isActive, isSelected: false })} ${lhcRowSurfaceClassName({ isActive, isSelected: false })}`}
        title={tooltip}
        onClick={() => onSelect(group.id)}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <UsersIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
          <span
            className={`min-w-0 flex-1 truncate text-sm ${status.isUnread ? "font-medium text-foreground" : ""}`}
          >
            {group.name}
          </span>
          {status.isUnread ? (
            <span
              aria-hidden
              className="size-1.5 shrink-0 rounded-full bg-primary"
              data-testid={`lhc-group-unread-${group.id}`}
            />
          ) : null}
          {working ? (
            <span
              className="flex shrink-0 items-center gap-1 text-[11px]"
              data-testid={`lhc-group-working-${group.id}`}
            >
              <ThreadStatusLabel status={WORKING_STATUS_PILL} compact />
              <span className={WORKING_STATUS_PILL.colorClass}>{status.workingLabel}</span>
            </span>
          ) : failed ? (
            <span
              className="flex shrink-0 items-center gap-1 text-[11px] text-destructive"
              data-testid={`lhc-group-failed-${group.id}`}
            >
              <CircleXIcon aria-label="Failed" className="size-3 shrink-0" />
              <span>{status.failedLabel}</span>
            </span>
          ) : (
            <span className="shrink-0 text-secondary-label text-[11px] tabular-nums">
              {status.latestAt
                ? formatRelativeTimeLabel(status.latestAt)
                : group.members.map((m) => m.label).join(" · ")}
            </span>
          )}
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
}
