// Fork-only (LHC): the Groups section of the LHC sidebar. Lists the console's
// group lines (proxied by this server); selecting one opens the group chat
// page. Collapse is component state: no client setting, no upstream touch.
import { ChevronRightIcon, UsersIcon } from "lucide-react";
import { memo, useState } from "react";
import { useParams, useRouter } from "@tanstack/react-router";
import type { LhcGroupSummary } from "../lhcGroups.logic";
import { useLhcGroups } from "../lhcGroups";
import { lhcRowSurfaceClassName } from "./LhcSidebar.logic";
import { resolveThreadRowClassName } from "./Sidebar.logic";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";

export function LhcGroupsSection() {
  const { groups } = useLhcGroups();
  const [expanded, setExpanded] = useState(true);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const activeGroupId = useParams({
    strict: false,
    select: (params) => (params as { groupId?: string }).groupId ?? null,
  });
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
        void router.navigate({ to: "/groups/$groupId", params: { groupId } });
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
}) {
  const { groups, activeGroupId, expanded, onToggleExpanded, onSelect } = props;
  return (
    <SidebarGroup className="px-2 pt-1 pb-0" data-testid="lhc-groups-section">
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={`Groups (${groups.length})`}
        data-testid="lhc-groups-header"
        className="mb-1 flex h-6 w-full cursor-pointer items-center gap-1 rounded-md pl-1.5 pr-1.5 text-left text-xs font-medium text-secondary-label hover:bg-foreground/5 hover:text-foreground"
        onClick={onToggleExpanded}
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        <span className="truncate">Groups ({groups.length})</span>
      </button>
      {expanded ? (
        <SidebarMenu>
          <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 gap-0.5 overflow-hidden border-l-0 px-1 py-0 sm:mx-1 sm:px-1">
            {groups.map((group) => {
              const isActive = group.id === activeGroupId;
              return (
                <SidebarMenuSubItem
                  key={group.id}
                  className="w-full"
                  data-testid={`lhc-group-${group.id}`}
                >
                  <SidebarMenuSubButton
                    size="sm"
                    isActive={isActive}
                    data-testid={`lhc-group-row-${group.id}`}
                    className={`${resolveThreadRowClassName({ isActive, isSelected: false })} ${lhcRowSurfaceClassName({ isActive, isSelected: false })}`}
                    title={`${group.name}: ${group.members.map((m) => m.label).join(", ")}`}
                    onClick={() => onSelect(group.id)}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-1.5">
                      <UsersIcon className="size-3.5 shrink-0 text-muted-foreground/80" />
                      <span className="min-w-0 flex-1 truncate text-sm">{group.name}</span>
                      <span className="shrink-0 text-secondary-label text-[11px]">
                        {group.members.map((m) => m.label).join(" · ")}
                      </span>
                    </div>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              );
            })}
          </SidebarMenuSub>
        </SidebarMenu>
      ) : null}
    </SidebarGroup>
  );
});
