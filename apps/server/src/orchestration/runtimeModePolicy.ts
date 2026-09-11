import {
  isRuntimeModePermitted,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type RuntimeMode,
  type RuntimeModePolicy,
} from "@t3tools/contracts";

import { findThreadById } from "./commandInvariants.ts";

const forbiddenRuntimeModeDetail = (mode: RuntimeMode): string =>
  `Runtime mode '${mode}' is not allowed by the configured access-mode policy.`;

/**
 * Live create/set/start only. History import is offline and is not gated here.
 * turn.start always uses the stored thread mode: WS bootstrap creates the
 * thread first, then dispatches the turn without bootstrap, and the decider
 * emits `targetThread.runtimeMode`. The command's schema default is ignored.
 */
export const commandRuntimeMode = (command: OrchestrationCommand): RuntimeMode | undefined => {
  switch (command.type) {
    case "thread.create":
    case "thread.runtime-mode.set":
      return command.runtimeMode;
    default:
      return undefined;
  }
};

export const inheritedThreadRuntimeMode = (
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
): RuntimeMode | undefined => {
  if (command.type !== "thread.turn.start") {
    return undefined;
  }
  return findThreadById(readModel, command.threadId)?.runtimeMode;
};

export const rejectForbiddenRuntimeMode = (
  command: OrchestrationCommand,
  readModel: OrchestrationReadModel,
  policy: RuntimeModePolicy | undefined,
): string | undefined => {
  const explicit = commandRuntimeMode(command);
  if (explicit !== undefined && !isRuntimeModePermitted(explicit, policy)) {
    return forbiddenRuntimeModeDetail(explicit);
  }
  const inherited = inheritedThreadRuntimeMode(command, readModel);
  if (inherited !== undefined && !isRuntimeModePermitted(inherited, policy)) {
    return forbiddenRuntimeModeDetail(inherited);
  }
  return undefined;
};
