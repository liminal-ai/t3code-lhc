/**
 * Deterministic identities for LHC imports. Every id derived here is a UUID v5
 * under one fixed namespace, keyed by the source LHC thread and the source row,
 * so re-running an import derives the same ids and the engine's normal
 * thread-absence validation refuses the duplicate.
 */
import * as NodeCrypto from "node:crypto";

import { EventId, MessageId, ThreadId, TurnId } from "@t3tools/contracts";

/**
 * Fixed UUID v5 namespace for imported identities. Changing it changes every
 * derived id, so it is a constant, not configuration.
 */
export const IMPORTED_THREAD_NAMESPACE = "9c3f2d54-6b1e-4f8a-9a5c-2e7d1b0c8f43";

const uuidBytes = (uuid: string): Uint8Array => Buffer.from(uuid.replace(/-/g, ""), "hex");

const formatUuid = (bytes: Uint8Array): string => {
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

/** RFC 4122 UUID v5 (SHA-1) over `namespace` and `name`. */
export function uuidV5(namespace: string, name: string): string {
  const hash = NodeCrypto.createHash("sha1")
    .update(uuidBytes(namespace))
    .update(Buffer.from(name, "utf8"))
    .digest();
  const bytes = Uint8Array.prototype.slice.call(hash, 0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return formatUuid(bytes);
}

const importedId = (sourceThreadId: string, ...parts: ReadonlyArray<string>): string =>
  uuidV5(IMPORTED_THREAD_NAMESPACE, ["cc-lhc", sourceThreadId, ...parts].join(":"));

/**
 * Deterministic t3code thread id for a source LHC thread: UUID v5 over
 * `cc-lhc:<source thread id>`.
 */
export function deriveImportedThreadId(sourceThreadId: string): ThreadId {
  return ThreadId.make(importedId(sourceThreadId));
}

/** t3code turn id for the prompted (folded) turn opened by a source message. */
export function deriveImportedTurnId(sourceThreadId: string, sourceMessageId: string): TurnId {
  return TurnId.make(importedId(sourceThreadId, "turn", sourceMessageId));
}

/** t3code message id for a source user prompt or assistant text message. */
export function deriveImportedMessageId(
  sourceThreadId: string,
  sourceMessageId: string,
): MessageId {
  return MessageId.make(importedId(sourceThreadId, "message", sourceMessageId));
}

/** Activity id for a source message (tool result, runtime note) or a synthetic row. */
export function deriveImportedActivityId(sourceThreadId: string, key: string): EventId {
  return EventId.make(importedId(sourceThreadId, "activity", key));
}
