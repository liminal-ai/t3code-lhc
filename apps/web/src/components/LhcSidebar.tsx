// Fork-only: the LHC left-nav view. Composition of the
// fork-owned Agents section (LhcAgentsSection.tsx) over the upstream legacy
// Projects tree, wired through LegacySidebar's slots seam (FORK.md "LHC sidebar").
import { useCallback, useMemo } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useThreadActions } from "../hooks/useThreadActions";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import type { SidebarThreadSummary } from "../types";
import LegacySidebar, { LegacySidebarSlotsContext, type LegacySidebarSlots } from "./LegacySidebar";
import { LhcAgentsSection, useLhcAgentsModel } from "./LhcAgentsSection";
import { LhcGroupsSection } from "./LhcGroupsSection";
import { lhcRowSurfaceClassName } from "./LhcSidebar.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/** Presentation only: pinned threads render under Agents, not in the tree. */
const treeThreadFilter = (thread: SidebarThreadSummary) => thread.pinnedAt == null;

export default function LhcSidebar() {
  const model = useLhcAgentsModel();
  const projectsExpanded = useClientSettings((settings) => settings.lhcProjectsExpanded);
  const updateSettings = useUpdateClientSettings();
  const { pinThread } = useThreadActions();
  const onToggleProjectsExpanded = useCallback(() => {
    updateSettings({ lhcProjectsExpanded: !projectsExpanded });
  }, [projectsExpanded, updateSettings]);
  const pinAsAgent = useCallback(
    (threadRef: ScopedThreadRef) => {
      void (async () => {
        const result = await pinThread(threadRef);
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Failed to pin thread",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [pinThread],
  );
  const slots = useMemo(
    (): LegacySidebarSlots => ({
      above: (
        <>
          <LhcAgentsSection model={model} />
          <LhcGroupsSection />
        </>
      ),
      treeThreadFilter,
      projectsExpanded,
      onToggleProjectsExpanded,
      rowSurfaceClassName: lhcRowSurfaceClassName,
      rowMenuExtra: { label: "Pin as agent", run: pinAsAgent },
      threadKeysAbove: model.visibleThreadKeys,
    }),
    [model, onToggleProjectsExpanded, pinAsAgent, projectsExpanded],
  );
  return (
    <LegacySidebarSlotsContext.Provider value={slots}>
      <LegacySidebar />
    </LegacySidebarSlotsContext.Provider>
  );
}
