// Fork-only (LHC sidebar): the Agents section rendered above the legacy
// Projects tree. Pinned, non-archived threads are agents, ordered by last-turn
// activity; flat or grouped by project (header context menu). Own rows, own
// context menu, own collapse keys. Row actions reuse the shared thread hooks.
import { ArchiveIcon, ChevronRightIcon, PinOffIcon } from "lucide-react";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";
import { type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import {
  parseScopedThreadKey,
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useParams, useRouter } from "@tanstack/react-router";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "../connection/desktopLocal";
import { useNewThreadHandler } from "../hooks/useHandleNewThread";
import { useThreadActions } from "../hooks/useThreadActions";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { readLocalApi } from "../localApi";
import { derivePhysicalProjectKey, selectProjectGroupingSettings } from "../logicalProject";
import {
  buildPhysicalToLogicalProjectKeyMap,
  buildSidebarProjectSnapshots,
  type SidebarProjectSnapshot,
} from "../sidebarProjectGrouping";
import { readThreadShell, useProjects, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import {
  getThreadKeysToDeselectAfterDelete,
  useThreadSelectionStore,
} from "../threadSelectionStore";
import { buildThreadRouteParams, resolveThreadRouteTarget } from "../threadRoutes";
import { formatRelativeTimeLabel } from "../timestampFormat";
import type { SidebarThreadSummary } from "../types";
import { resolveProjectExpanded, useUiStateStore } from "../uiStateStore";
import {
  LHC_AGENTS_EXPANSION_PREFIX,
  isLhcAgent,
  lastTurnActivityStamp,
  lhcRowSurfaceClassName,
  orderAgentProjects,
  sortThreadsByLastTurn,
} from "./LhcSidebar.logic";
import { ProjectFavicon } from "./ProjectFavicon";
import { isMacPlatform } from "../lib/utils";
import {
  hasUnseenCompletion,
  archiveSelectedThreadEntries,
  buildMultiSelectThreadContextMenuItems,
  deleteSelectedThreadEntries,
  isSidebarNestedLinkClick,
  isTrailingDoubleClick,
  resolveThreadRowClassName,
} from "./Sidebar.logic";
import { Menu, MenuCheckboxItem, MenuPopup } from "./ui/menu";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  useSidebar,
} from "./ui/sidebar";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const ICON_ACTION_BUTTON_CLASS =
  "inline-flex size-5 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-sidebar-row-hover hover:text-foreground";

export interface LhcAgentsGroup {
  readonly project: SidebarProjectSnapshot;
  readonly agents: readonly SidebarThreadSummary[];
  readonly expanded: boolean;
  readonly expansionKeys: readonly string[];
}

export interface LhcAgentsModel {
  readonly expanded: boolean;
  readonly groupByProject: boolean;
  readonly agents: readonly SidebarThreadSummary[];
  readonly groups: readonly LhcAgentsGroup[];
  /** Thread keys in display order, honoring both collapse levels (keyboard order). */
  readonly visibleThreadKeys: readonly string[];
  readonly projectOf: (thread: SidebarThreadSummary) => SidebarProjectSnapshot | null;
  /** The thread's exact member project root (not the logical group's). */
  readonly workspaceRootOf: (thread: SidebarThreadSummary) => string | null;
}

function agentsExpansionKeys(project: SidebarProjectSnapshot): string[] {
  const keys = [project.projectKey];
  for (const member of project.memberProjects) {
    if (member.physicalProjectKey !== project.projectKey) keys.push(member.physicalProjectKey);
  }
  return keys.map((key) => LHC_AGENTS_EXPANSION_PREFIX + key);
}

export function useLhcAgentsModel(): LhcAgentsModel {
  const sidebarThreads = useThreadShells();
  const projects = useProjects();
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const expanded = useClientSettings((settings) => settings.lhcAgentsExpanded);
  const groupByProject = useClientSettings((settings) => settings.lhcAgentsGroupByProject);
  const projectExpandedById = useUiStateStore((store) => store.projectExpandedById);

  // Same logical-project resolution the legacy tree uses (grouping settings, environment labels).
  const snapshots = useMemo(() => {
    const labelById = new Map(environments.map((e) => [e.environmentId, e.label] as const));
    const desktopLocal = new Set(
      environments
        .filter((e) => isDesktopLocalConnectionTarget(e.entry.target))
        .map((e) => e.environmentId),
    );
    const wsl = new Set(
      environments.filter((e) => isWslConnectionTarget(e.entry.target)).map((e) => e.environmentId),
    );
    return buildSidebarProjectSnapshots({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
      resolveEnvironmentLabel: (environmentId) => labelById.get(environmentId) ?? null,
      isDesktopLocalEnvironment: (environmentId) => desktopLocal.has(environmentId),
      isWslEnvironment: (environmentId) => wsl.has(environmentId),
    });
  }, [environments, primaryEnvironmentId, projectGroupingSettings, projects]);
  const logicalKeyByScopedRef = useMemo(() => {
    const physicalToLogical = buildPhysicalToLogicalProjectKeyMap({
      projects,
      settings: projectGroupingSettings,
      primaryEnvironmentId,
    });
    return new Map(
      projects.map((project) => {
        const physicalKey = derivePhysicalProjectKey(project);
        return [
          scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
          physicalToLogical.get(physicalKey) ?? physicalKey,
        ] as const;
      }),
    );
  }, [primaryEnvironmentId, projectGroupingSettings, projects]);
  const snapshotByKey = useMemo(
    () => new Map(snapshots.map((snapshot) => [snapshot.projectKey, snapshot] as const)),
    [snapshots],
  );
  const logicalKeyOf = useCallback(
    (thread: SidebarThreadSummary) => {
      const scoped = scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId));
      return logicalKeyByScopedRef.get(scoped) ?? scoped;
    },
    [logicalKeyByScopedRef],
  );
  const projectOf = useCallback(
    (thread: SidebarThreadSummary) => snapshotByKey.get(logicalKeyOf(thread)) ?? null,
    [logicalKeyOf, snapshotByKey],
  );
  const workspaceRootOf = useCallback(
    (thread: SidebarThreadSummary) =>
      projects.find(
        (project) =>
          project.environmentId === thread.environmentId && project.id === thread.projectId,
      )?.workspaceRoot ?? null,
    [projects],
  );

  return useMemo((): LhcAgentsModel => {
    const agents = sortThreadsByLastTurn(sidebarThreads.filter(isLhcAgent));
    const groups = orderAgentProjects(snapshots, agents, logicalKeyOf).map((project) => {
      const expansionKeys = agentsExpansionKeys(project);
      return {
        project,
        agents: agents.filter((thread) => logicalKeyOf(thread) === project.projectKey),
        expanded: resolveProjectExpanded(projectExpandedById, expansionKeys),
        expansionKeys,
      };
    });
    const keyOf = (thread: SidebarThreadSummary) =>
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const visibleThreadKeys = !expanded
      ? []
      : groupByProject
        ? groups.flatMap((group) => (group.expanded ? group.agents.map(keyOf) : []))
        : agents.map(keyOf);
    return {
      expanded,
      groupByProject,
      agents,
      groups,
      visibleThreadKeys,
      projectOf,
      workspaceRootOf,
    };
  }, [
    expanded,
    groupByProject,
    logicalKeyOf,
    projectExpandedById,
    projectOf,
    sidebarThreads,
    snapshots,
    workspaceRootOf,
  ]);
}

function LhcAgentsHeader(props: {
  readonly count: number;
  readonly expanded: boolean;
  readonly groupByProject: boolean;
  readonly onToggleExpanded: () => void;
  readonly onToggleGroupByProject: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  return (
    <Menu open={menuOpen} onOpenChange={setMenuOpen}>
      <button
        ref={anchorRef}
        type="button"
        aria-expanded={props.expanded}
        aria-label={`Agents (${props.count})`}
        data-testid="lhc-agents-header"
        className="mb-1 flex h-6 w-full cursor-pointer items-center gap-1 rounded-md pl-1.5 pr-1.5 text-left text-xs font-medium text-sidebar-muted-foreground/80 hover:bg-foreground/6"
        onClick={props.onToggleExpanded}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenuOpen(true);
        }}
      >
        <ChevronRightIcon
          className={`size-3.5 shrink-0 transition-transform duration-150 ${props.expanded ? "rotate-90" : ""}`}
        />
        <span className="truncate">Agents ({props.count})</span>
      </button>
      <MenuPopup align="start" anchor={anchorRef}>
        <MenuCheckboxItem
          checked={props.groupByProject}
          closeOnClick
          onCheckedChange={() => props.onToggleGroupByProject()}
        >
          Group by project
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
}

const LhcAgentRow = memo(function LhcAgentRow(props: {
  readonly thread: SidebarThreadSummary;
  readonly project: SidebarProjectSnapshot | null;
  readonly workspaceRoot: string | null;
  readonly isActive: boolean;
  /** Visible agent keys in display order, for shift-range selection. */
  readonly orderedKeys: readonly string[];
  readonly onMultiSelectContextMenu: (position: { x: number; y: number }) => Promise<void>;
}) {
  const { thread, project, workspaceRoot, isActive, orderedKeys, onMultiSelectContextMenu } = props;
  const threadRef = useMemo(
    () => scopeThreadRef(thread.environmentId, thread.id),
    [thread.environmentId, thread.id],
  );
  const threadKey = scopedThreadKey(threadRef);
  const router = useRouter();
  const { isMobile, setOpenMobile } = useSidebar();
  const { archiveThread, deleteThread, unpinThread } = useThreadActions();
  const handleNewThread = useNewThreadHandler();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const setSelectionAnchor = useThreadSelectionStore((state) => state.setAnchor);
  const toggleThreadSelection = useThreadSelectionStore((state) => state.toggleThread);
  const rangeSelectTo = useThreadSelectionStore((state) => state.rangeSelectTo);
  const isSelected = useThreadSelectionStore((state) => state.selectedThreadKeys.has(threadKey));
  const confirmThreadDelete = useClientSettings<boolean>((s) => s.confirmThreadDelete);
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const { copyToClipboard: copyThreadId } = useCopyToClipboard<{ threadId: ThreadId }>({
    onCopy: (ctx) =>
      toastManager.add({ type: "success", title: "Thread ID copied", description: ctx.threadId }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy thread ID",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });
  const { copyToClipboard: copyPath } = useCopyToClipboard<{ path: string }>({
    onCopy: (ctx) =>
      toastManager.add({ type: "success", title: "Path copied", description: ctx.path }),
    onError: (error) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to copy path",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      ),
  });
  const [renaming, setRenaming] = useState<string | null>(null);
  const renameCommittedRef = useRef(false);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const failToast = useCallback((title: string, error: unknown) => {
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }, []);
  const navigateToThread = useCallback(() => {
    if (useThreadSelectionStore.getState().selectedThreadKeys.size > 0) clearSelection();
    setSelectionAnchor(threadKey);
    if (isMobile) setOpenMobile(false);
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
  }, [clearSelection, isMobile, router, setOpenMobile, setSelectionAnchor, threadKey, threadRef]);
  const commitRename = useCallback(async () => {
    const value = renaming;
    setRenaming(null);
    if (value === null) return;
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (trimmed === thread.title) return;
    const result = await updateThreadMetadata({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, title: trimmed },
    });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failToast("Failed to rename thread", squashAtomCommandFailure(result));
    }
  }, [failToast, renaming, thread.title, threadRef, updateThreadMetadata]);
  const runUnpin = useCallback(async () => {
    const result = await unpinThread(threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failToast("Failed to unpin thread", squashAtomCommandFailure(result));
    }
  }, [failToast, threadRef, unpinThread]);
  const runArchive = useCallback(async () => {
    const result = await archiveThread(threadRef);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      failToast("Failed to archive thread", squashAtomCommandFailure(result));
    }
  }, [archiveThread, failToast, threadRef]);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      const api = readLocalApi();
      if (!api) return;
      const position = { x: event.clientX, y: event.clientY };
      const hasSelection = useThreadSelectionStore.getState().hasSelection();
      if (hasSelection && isSelected) {
        void (async () => {
          const result = await settlePromise(() => onMultiSelectContextMenu(position));
          if (result._tag === "Failure") {
            failToast("Thread action failed", squashAtomCommandFailure(result));
          }
        })();
        return;
      }
      if (hasSelection) clearSelection();
      void (async () => {
        const result = await settlePromise(async () => {
          const clicked = await api.contextMenu.show(
            [
              ...(thread.branch
                ? [{ id: "new-thread-on-branch", label: `New thread on ${thread.branch}` }]
                : []),
              { id: "rename", label: "Rename thread" },
              { id: "unpin", label: "Unpin" },
              { id: "mark-unread", label: "Mark unread" },
              { id: "copy-path", label: "Copy Path" },
              { id: "copy-thread-id", label: "Copy Thread ID" },
              { id: "project-settings", label: "Project settings" },
              { id: "delete", label: "Delete", destructive: true, icon: "trash" },
            ],
            position,
          );
          if (clicked === "new-thread-on-branch") {
            const created = await settlePromise(() =>
              handleNewThread(scopeProjectRef(thread.environmentId, thread.projectId), {
                branch: thread.branch,
                worktreePath: thread.worktreePath,
                envMode: thread.worktreePath ? "worktree" : "local",
                startFromOrigin: false,
              }),
            );
            if (created._tag === "Failure") {
              failToast("Could not create thread", squashAtomCommandFailure(created));
            }
            return;
          }
          if (clicked === "rename") {
            renameCommittedRef.current = false;
            setRenaming(thread.title);
            return;
          }
          if (clicked === "unpin") {
            await runUnpin();
            return;
          }
          if (clicked === "mark-unread") {
            markThreadUnread(threadKey, thread.latestTurn?.completedAt);
            return;
          }
          if (clicked === "copy-path") {
            // The thread's exact member project, never the logical group's root.
            const path = thread.worktreePath ?? workspaceRoot ?? null;
            if (!path) {
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Path unavailable",
                  description: "This thread does not have a workspace path to copy.",
                }),
              );
              return;
            }
            copyPath(path, { path });
            return;
          }
          if (clicked === "copy-thread-id") {
            copyThreadId(thread.id, { threadId: thread.id });
            return;
          }
          if (clicked === "project-settings") {
            if (!project) return;
            if (isMobile) setOpenMobile(false);
            void router.navigate({
              to: "/projects/$projectKey",
              params: { projectKey: project.projectKey },
            });
            return;
          }
          if (clicked !== "delete") return;
          if (confirmThreadDelete) {
            const confirmed = await api.dialogs.confirm(
              [
                `Delete thread "${thread.title}"?`,
                "This permanently clears conversation history for this thread.",
              ].join("\n"),
              { variant: "destructive" },
            );
            if (!confirmed) return;
          }
          const deleted = await deleteThread(threadRef);
          if (deleted._tag === "Failure" && !isAtomCommandInterrupted(deleted)) {
            failToast("Failed to delete thread", squashAtomCommandFailure(deleted));
          }
        });
        if (result._tag === "Failure") {
          failToast("Thread action failed", squashAtomCommandFailure(result));
        }
      })();
    },
    [
      clearSelection,
      confirmThreadDelete,
      copyPath,
      copyThreadId,
      deleteThread,
      failToast,
      handleNewThread,
      isMobile,
      isSelected,
      markThreadUnread,
      onMultiSelectContextMenu,
      project,
      router,
      runUnpin,
      setOpenMobile,
      thread,
      threadKey,
      threadRef,
      workspaceRoot,
    ],
  );
  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (isSidebarNestedLinkClick(event.target)) return;
      const isModClick = isMacPlatform(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (isModClick) {
        event.preventDefault();
        toggleThreadSelection(threadKey);
        return;
      }
      if (event.shiftKey) {
        event.preventDefault();
        rangeSelectTo(threadKey, orderedKeys);
        return;
      }
      if (isTrailingDoubleClick(event.detail)) return;
      navigateToThread();
    },
    [navigateToThread, orderedKeys, rangeSelectTo, threadKey, toggleThreadSelection],
  );
  const handleDoubleClick = useCallback(
    (event: React.MouseEvent) => {
      if (renaming !== null || isMobile) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if ((event.target as HTMLElement).closest("button, a")) return;
      event.preventDefault();
      renameCommittedRef.current = false;
      setRenaming(thread.title);
    },
    [isMobile, renaming, thread.title],
  );
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      navigateToThread();
    },
    [navigateToThread],
  );
  const stopPointer = useCallback((event: React.PointerEvent) => event.stopPropagation(), []);
  const rowRender = useMemo(() => <div role="button" tabIndex={0} />, []);
  const ageStamp = lastTurnActivityStamp(thread);
  const isRunning = thread.session?.status === "running" && thread.session.activeTurnId != null;
  const statusLabel = isRunning ? "Running" : formatRelativeTimeLabel(ageStamp);
  // F4: "finished since you last looked", Theo's rule (never-visited counts as read); a running
  // row never lights up. Cleared by upstream's markThreadVisited when the thread is opened.
  const lastVisitedAt = useUiStateStore(
    (state) => state.threadLastVisitedAtById[threadKey] ?? undefined,
  );
  const isUnread = !isRunning && hasUnseenCompletion({ ...thread, lastVisitedAt });
  const hoverActionWrapClass =
    "pointer-events-none absolute top-1/2 -translate-y-1/2 opacity-0 transition-opacity duration-150 max-sm:pointer-events-auto max-sm:opacity-100 group-hover/menu-sub-item:pointer-events-auto group-hover/menu-sub-item:opacity-100 group-focus-within/menu-sub-item:pointer-events-auto group-focus-within/menu-sub-item:opacity-100";

  return (
    <SidebarMenuSubItem className="w-full" data-thread-item data-testid={`lhc-agent-${thread.id}`}>
      <SidebarMenuSubButton
        render={rowRender}
        size="sm"
        isActive={isActive}
        data-testid={`thread-row-${thread.id}`}
        className={`${resolveThreadRowClassName({ isActive, isSelected })} ${lhcRowSurfaceClassName({ isActive, isSelected })} relative isolate`}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {renaming !== null ? (
            <input
              ref={(element) => {
                if (element && renameInputRef.current !== element) {
                  renameInputRef.current = element;
                  element.focus();
                  element.select();
                }
              }}
              className="min-w-0 flex-1 truncate rounded border border-ring bg-transparent px-0.5 text-sm outline-none"
              value={renaming}
              onChange={(event) => setRenaming(event.target.value)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") {
                  event.preventDefault();
                  renameCommittedRef.current = true;
                  void commitRename();
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  renameCommittedRef.current = true;
                  setRenaming(null);
                }
              }}
              onBlur={() => {
                if (!renameCommittedRef.current) void commitRename();
              }}
              onClick={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            />
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <span
                    className={`min-w-0 flex-1 truncate text-sm ${isUnread ? "font-medium text-foreground" : ""}`}
                    data-testid={`thread-title-${thread.id}`}
                    data-unread={isUnread ? "true" : undefined}
                  >
                    {thread.title}
                  </span>
                }
              />
              <TooltipPopup side="top" className="max-w-80 whitespace-normal leading-tight">
                {project ? `${project.displayName} · ${thread.title}` : thread.title}
              </TooltipPopup>
            </Tooltip>
          )}
          {isUnread ? (
            <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-primary" />
          ) : null}
          <span className="shrink-0 text-secondary-label text-[11px] tabular-nums max-sm:pr-11 group-hover/menu-sub-item:opacity-0 group-focus-within/menu-sub-item:opacity-0">
            {statusLabel}
          </span>
        </div>
        <div className={`${hoverActionWrapClass} right-6`}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-thread-selection-safe
                  data-testid={`thread-unpin-${thread.id}`}
                  aria-label={`Unpin ${thread.title}`}
                  className={ICON_ACTION_BUTTON_CLASS}
                  onPointerDown={stopPointer}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void runUnpin();
                  }}
                >
                  <PinOffIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">Unpin</TooltipPopup>
          </Tooltip>
        </div>
        <div className={`${hoverActionWrapClass} right-0.5`}>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  data-thread-selection-safe
                  data-testid={`thread-archive-${thread.id}`}
                  aria-label={`Archive ${thread.title}`}
                  className={ICON_ACTION_BUTTON_CLASS}
                  onPointerDown={stopPointer}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    void runArchive();
                  }}
                >
                  <ArchiveIcon className="size-3.5" />
                </button>
              }
            />
            <TooltipPopup side="top">Archive</TooltipPopup>
          </Tooltip>
        </div>
      </SidebarMenuSubButton>
    </SidebarMenuSubItem>
  );
});

/** Same multi-select menu as the legacy tree rows (mark unread, archive, delete). */
function useAgentsMultiSelectContextMenu() {
  const { archiveThread, deleteThread } = useThreadActions();
  const markThreadUnread = useUiStateStore((state) => state.markThreadUnread);
  const clearSelection = useThreadSelectionStore((state) => state.clearSelection);
  const removeFromSelection = useThreadSelectionStore((state) => state.removeFromSelection);
  const confirmArchive = useClientSettings<boolean>((s) => s.confirmThreadArchive);
  const confirmDelete = useClientSettings<boolean>((s) => s.confirmThreadDelete);
  return useCallback(
    async (position: { x: number; y: number }) => {
      const api = readLocalApi();
      if (!api) return;
      const threadKeys = [...useThreadSelectionStore.getState().selectedThreadKeys];
      if (threadKeys.length === 0) return;
      const count = threadKeys.length;
      const entries = threadKeys.flatMap((threadKey) => {
        const threadRef = parseScopedThreadKey(threadKey);
        const thread = threadRef ? readThreadShell(threadRef) : null;
        return threadRef && thread ? [{ threadKey, threadRef, thread }] : [];
      });
      const hasRunningThread = entries.some(
        ({ thread }) => thread.session?.status === "running" && thread.session.activeTurnId != null,
      );
      const clicked = await api.contextMenu.show(
        buildMultiSelectThreadContextMenuItems({ count, hasRunningThread }),
        position,
      );
      const fail = (title: string, error: unknown) =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title,
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      if (clicked === "mark-unread") {
        for (const { threadKey, thread } of entries) {
          markThreadUnread(threadKey, thread.latestTurn?.completedAt);
        }
        clearSelection();
        return;
      }
      if (clicked === "archive") {
        if (confirmArchive) {
          const confirmed = await api.dialogs.confirm(
            `Archive ${count} thread${count === 1 ? "" : "s"}?`,
          );
          if (!confirmed) return;
        }
        const outcome = await archiveSelectedThreadEntries({
          entries,
          archive: ({ threadRef }, onArchived) => archiveThread(threadRef, { onArchived }),
        });
        for (const failure of outcome.followupFailures) {
          if (!isAtomCommandInterrupted(failure)) {
            fail("Thread archived, but navigation failed", squashAtomCommandFailure(failure));
          }
        }
        if (outcome.mutationFailure) {
          removeFromSelection(outcome.archivedThreadKeys);
          if (!isAtomCommandInterrupted(outcome.mutationFailure)) {
            fail("Failed to archive threads", squashAtomCommandFailure(outcome.mutationFailure));
          }
          return;
        }
        removeFromSelection(threadKeys);
        return;
      }
      if (clicked !== "delete") return;
      if (confirmDelete) {
        const confirmed = await api.dialogs.confirm(
          [
            `Delete ${count} thread${count === 1 ? "" : "s"}?`,
            "This permanently clears conversation history for these threads.",
          ].join("\n"),
          { variant: "destructive" },
        );
        if (!confirmed) return;
      }
      const { deletedThreadKeys, firstFailure } = await deleteSelectedThreadEntries({
        entries,
        delete: ({ threadRef }, deletedThreadKeys) =>
          deleteThread(threadRef, { deletedThreadKeys }),
      });
      if (firstFailure !== null) {
        fail("Failed to delete threads", squashAtomCommandFailure(firstFailure));
      }
      removeFromSelection(
        getThreadKeysToDeselectAfterDelete(threadKeys, deletedThreadKeys, (threadKey) => {
          const threadRef = parseScopedThreadKey(threadKey);
          return threadRef !== null && readThreadShell(threadRef) !== null;
        }),
      );
    },
    [
      archiveThread,
      clearSelection,
      confirmArchive,
      confirmDelete,
      deleteThread,
      markThreadUnread,
      removeFromSelection,
    ],
  );
}

export function LhcAgentsSection(props: { readonly model: LhcAgentsModel }) {
  const { model } = props;
  const updateSettings = useUpdateClientSettings();
  const setProjectExpanded = useUiStateStore((state) => state.setProjectExpanded);
  const onMultiSelectContextMenu = useAgentsMultiSelectContextMenu();
  const routeThreadKey = useParams({
    strict: false,
    select: (params) => {
      const target = resolveThreadRouteTarget(params);
      return target?.kind === "server" ? scopedThreadKey(target.threadRef) : null;
    },
  });
  const rows = (agents: readonly SidebarThreadSummary[]) =>
    agents.map((thread) => (
      <LhcAgentRow
        key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
        thread={thread}
        project={model.projectOf(thread)}
        workspaceRoot={model.workspaceRootOf(thread)}
        isActive={
          routeThreadKey === scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
        }
        orderedKeys={model.visibleThreadKeys}
        onMultiSelectContextMenu={onMultiSelectContextMenu}
      />
    ));
  return (
    <SidebarGroup className="px-2 pt-2 pb-0" data-testid="lhc-agents-section">
      <LhcAgentsHeader
        count={model.agents.length}
        expanded={model.expanded}
        groupByProject={model.groupByProject}
        onToggleExpanded={() => updateSettings({ lhcAgentsExpanded: !model.expanded })}
        onToggleGroupByProject={() =>
          updateSettings({ lhcAgentsGroupByProject: !model.groupByProject })
        }
      />
      {!model.expanded ? null : model.agents.length === 0 ? (
        <div className="px-2 pb-2 text-secondary-label text-xs">
          Pin a thread to make it an agent
        </div>
      ) : model.groupByProject ? (
        <SidebarMenu>
          {model.groups.map((group) => (
            <li key={`lhc-agents:${group.project.projectKey}`} className="list-none">
              <button
                type="button"
                aria-expanded={group.expanded}
                data-testid={`lhc-agents-group-${group.project.projectKey}`}
                className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-foreground/6"
                onClick={() => setProjectExpanded(group.expansionKeys, !group.expanded)}
              >
                <ChevronRightIcon
                  className={`-ml-0.5 size-3.5 shrink-0 text-muted-foreground/70 transition-transform duration-150 ${group.expanded ? "rotate-90" : ""}`}
                />
                <span className="flex shrink-0">
                  <ProjectFavicon
                    environmentId={group.project.environmentId}
                    cwd={group.project.workspaceRoot}
                    projectName={group.project.title}
                    faviconPath={group.project.faviconPath}
                    projectIcon={group.project.projectIcon}
                  />
                </span>
                <span className="truncate text-sm font-medium text-sidebar-foreground/90">
                  {group.project.displayName}
                </span>
                <span className="ml-auto shrink-0 text-secondary-label text-[10px]">
                  {group.agents.length}
                </span>
              </button>
              {group.expanded ? (
                <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 gap-0.5 overflow-hidden border-l-0 px-1 py-0 sm:mx-1 sm:px-1.5">
                  {rows(group.agents)}
                </SidebarMenuSub>
              ) : null}
            </li>
          ))}
        </SidebarMenu>
      ) : (
        <SidebarMenu>
          <SidebarMenuSub className="mx-0.5 my-0 w-full translate-x-0 gap-0.5 overflow-hidden border-l-0 px-1 py-0 sm:mx-1 sm:px-1.5">
            {rows(model.agents)}
          </SidebarMenuSub>
        </SidebarMenu>
      )}
    </SidebarGroup>
  );
}
