// Fork-only regression (lhc.7 hardening, item 2): under the LHC view the tree
// hides pinned threads, but project removal must still count them. A project
// whose only live thread is a pinned agent gets the existing non-empty
// confirmation through the real removal path; cancelling sends no delete.
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import React from "react";
(globalThis as { __lhcCreateElement?: unknown }).__lhcCreateElement = React.createElement;
// The removal path awaits window.setTimeout; there is no DOM in this suite.
if (globalThis.window === undefined) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: globalThis });
}
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  toasts: [] as Array<Record<string, unknown>>,
  contextMenuShow: vi.fn(async () => "delete:env-1:proj-1"),
  confirm: vi.fn(async () => false),
  deleteProject: vi.fn(async () => ({ _tag: "Success" })),
  navigate: vi.fn(),
}));

const { passthrough } = vi.hoisted(() => ({
  passthrough: (tag: string) =>
    function Passthrough({
      children,
      render: _render,
      ...props
    }: Record<string, unknown> & { readonly children?: unknown; readonly render?: unknown }) {
      // React is not importable inside a hoisted factory; use the global createElement shim below.
      return (globalThis as { __lhcCreateElement?: (...args: unknown[]) => unknown })
        .__lhcCreateElement!(tag, props, children);
    },
}));

vi.mock("../localApi", () => ({
  readLocalApi: () => ({
    contextMenu: { show: state.contextMenuShow },
    dialogs: { confirm: state.confirm },
  }),
  ensureLocalApi: () => ({
    contextMenu: { show: state.contextMenuShow },
    dialogs: { confirm: state.confirm },
  }),
}));
vi.mock("./ui/toast", () => ({
  toastManager: {
    add: (toast: Record<string, unknown>) => {
      state.toasts.push(toast);
      return `toast-${state.toasts.length}`;
    },
    close: vi.fn(),
  },
  stackedThreadToast: (toast: Record<string, unknown>) => toast,
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { readonly name?: string }) =>
    command.name === "project.delete"
      ? state.deleteProject
      : vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("../state/projects", () => ({
  projectEnvironment: { delete: { name: "project.delete" }, update: { name: "project.update" } },
}));
vi.mock("../state/threads", () => ({
  threadEnvironment: { updateMetadata: { name: "thread.updateMetadata" } },
  useEnvironmentThread: () => null,
}));
vi.mock("../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useThreadShells: () => [],
  useThreadShellsForProjectRefs: () => [
    {
      id: "thread-1",
      environmentId: "env-1",
      projectId: "proj-1",
      title: "Pinned agent",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      archivedAt: null,
      pinnedAt: "2026-09-02T00:00:00.000Z",
      branch: null,
      worktreePath: null,
      latestTurn: null,
      session: null,
    },
  ],
}));
vi.mock("@tanstack/react-router", () => ({
  useRouter: () => ({ navigate: state.navigate, state: { matches: [] } }),
  useNavigate: () => state.navigate,
  useParams: () => null,
}));
vi.mock("./ui/sidebar", () => ({
  SidebarContent: passthrough("div"),
  SidebarGroup: passthrough("div"),
  SidebarMenu: passthrough("ul"),
  SidebarMenuButton: passthrough("button"),
  SidebarMenuItem: passthrough("li"),
  SidebarMenuSub: passthrough("ul"),
  SidebarMenuSubButton: passthrough("div"),
  SidebarMenuSubItem: passthrough("li"),
  useSidebar: () => ({ isMobile: false, setOpenMobile: vi.fn() }),
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: passthrough("span"),
  TooltipPopup: () => null,
  TooltipTrigger: passthrough("span"),
}));
vi.mock("./ui/dialog", () => ({
  Dialog: () => null,
  DialogDescription: () => null,
  DialogFooter: () => null,
  DialogHeader: () => null,
  DialogPanel: () => null,
  DialogPopup: () => null,
  DialogTitle: () => null,
}));
vi.mock("./ui/menu", () => ({
  Menu: passthrough("div"),
  MenuGroup: passthrough("div"),
  MenuPopup: () => null,
  MenuRadioGroup: passthrough("div"),
  MenuRadioItem: passthrough("div"),
  MenuTrigger: passthrough("div"),
  MenuCheckboxItem: passthrough("div"),
}));
vi.mock("./ui/select", () => ({
  Select: passthrough("div"),
  SelectItem: passthrough("div"),
  SelectPopup: () => null,
  SelectTrigger: passthrough("div"),
  SelectValue: passthrough("span"),
}));
vi.mock("./ui/number-field", () => ({
  NumberField: passthrough("div"),
  NumberFieldDecrement: passthrough("button"),
  NumberFieldGroup: passthrough("div"),
  NumberFieldIncrement: passthrough("button"),
  NumberFieldInput: passthrough("input"),
}));
vi.mock("./ui/input", () => ({ Input: passthrough("input") }));
vi.mock("./ui/button", () => ({ Button: passthrough("button") }));
vi.mock("./ui/alert", () => ({
  Alert: passthrough("div"),
  AlertAction: passthrough("div"),
  AlertDescription: passthrough("div"),
  AlertTitle: passthrough("div"),
}));
vi.mock("./ui/kbd", () => ({ Kbd: passthrough("kbd") }));
vi.mock("./ui/command", () => ({ CommandDialogTrigger: passthrough("div") }));
vi.mock("./ProjectFavicon", () => ({ ProjectFavicon: () => null }));
vi.mock("./EnvironmentMachineIcon", () => ({ EnvironmentMachineIcon: () => null }));
vi.mock("./ThreadStatusIndicators", () => ({
  ThreadStatusDot: () => null,
  ThreadStatusIcon: () => null,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeFooter: () => null,
  SidebarChromeHeader: () => null,
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (selector: (settings: Record<string, unknown>) => unknown) =>
    selector({
      sidebarThreadSortOrder: "updated",
      sidebarThreadPreviewCount: 5,
      confirmThreadDelete: true,
      confirmThreadArchive: true,
      sidebarProjectGroupingMode: "repository_path",
      sidebarProjectGroupingOverrides: {},
    }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("~/hooks/useCopyToClipboard", () => ({
  useCopyToClipboard: () => ({ copyToClipboard: vi.fn() }),
}));
vi.mock("../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("../hooks/useHandleNewThread", () => ({ useNewThreadHandler: () => vi.fn() }));
vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    archiveThread: vi.fn(),
    deleteThread: vi.fn(),
    pinThread: vi.fn(),
    unpinThread: vi.fn(),
  }),
}));
vi.mock("../state/environments", () => ({
  useEnvironment: () => null,
  useEnvironments: () => ({ environments: [] }),
  usePrimaryEnvironmentId: () => "env-1",
}));
vi.mock("../state/server", () => ({ primaryServerKeybindingsAtom: {} }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../state/desktopUpdate", () => ({ useDesktopUpdateState: () => null }));
vi.mock("../state/terminalSessions", () => ({ useThreadRunningTerminalIds: () => [] }));
vi.mock("../portDiscoveryState", () => ({ useThreadDiscoveredPorts: () => [] }));
vi.mock("../hooks/useTerminalFocus", () => ({ useTerminalFocus: () => false }));
vi.mock("../connection/useDesktopLocalBootstraps", () => ({ useDesktopLocalBootstraps: () => [] }));
vi.mock("~/hooks/useMediaQuery", () => ({ useIsMobile: () => false }));
vi.mock("../shortcutModifierState", () => ({ useShortcutModifierState: () => ({}) }));

import { LegacySidebarSlotsContext, SidebarProjectItem } from "./LegacySidebar";
import { useUiStateStore } from "../uiStateStore";

const member = {
  id: "proj-1",
  environmentId: "env-1",
  title: "Fork",
  workspaceRoot: "/srv/fork",
  physicalProjectKey: "env-1:proj-1",
  environmentLabel: null,
};
const project = {
  ...member,
  projectKey: "env-1:proj-1",
  displayName: "Fork",
  groupedProjectCount: 1,
  environmentPresence: "local-only" as const,
  allRemoteMembersAreDesktopLocal: false,
  remoteEnvironmentLabels: [],
  memberProjects: [member],
  memberProjectRefs: [{ environmentId: "env-1", projectId: "proj-1" }],
};

function renderItem(): ReactTestRenderer {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(
      React.createElement(
        LegacySidebarSlotsContext.Provider,
        // The LHC view's filter: pinned threads render under Agents, not in the tree.
        { value: { treeThreadFilter: (thread) => thread.pinnedAt == null } },
        React.createElement(SidebarProjectItem, {
          project: project as never,
          isThreadListExpanded: false,
          activeRouteThreadKey: null,
          openPullRequestsInRightPanel: false,
          newThreadShortcutLabel: null,
          handleNewThread: vi.fn() as never,
          archiveThread: vi.fn() as never,
          deleteThread: vi.fn() as never,
          threadJumpLabelByKey: new Map(),
          attachThreadListAutoAnimateRef: () => {},
          expandThreadListForProject: () => {},
          collapseThreadListForProject: () => {},
          dragInProgressRef: { current: false },
          suppressProjectClickAfterDragRef: { current: false },
          suppressProjectClickForContextMenuRef: { current: false },
          isManualProjectSorting: false,
          dragHandleProps: null,
        }),
      ),
    );
  });
  return renderer;
}

describe("LHC view: project removal counts pinned agents (fork)", () => {
  beforeEach(() => {
    state.toasts.length = 0;
    state.contextMenuShow.mockClear();
    state.confirm.mockClear();
    state.deleteProject.mockClear();
    useUiStateStore.getState().setProjectExpanded(["env-1:proj-1"], true);
  });

  it("warns that the project is not empty and sends no delete on cancel", async () => {
    const renderer = renderItem();
    const header = renderer.root
      .findAllByType("button")
      .find((node) => typeof node.props.onContextMenu === "function");
    expect(header).toBeDefined();
    await act(async () => {
      header!.props.onContextMenu({ preventDefault() {}, clientX: 1, clientY: 1 });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(state.contextMenuShow).toHaveBeenCalledTimes(1);
    const warning = state.toasts.find((toast) => toast.title === "Project is not empty");
    expect(warning).toBeDefined();
    const actionProps = warning!.actionProps as { onClick: () => void };
    await act(async () => {
      actionProps.onClick();
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(state.confirm).toHaveBeenCalledTimes(1);
    expect(String(state.confirm.mock.calls[0]?.[0])).toContain("delete its 1 thread?");
    expect(state.deleteProject).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
