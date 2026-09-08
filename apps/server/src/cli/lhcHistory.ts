/**
 * Raw-history backfill plan: cc-lhc thread record → offline orchestration commands.
 *
 * Pure. Given the messages of a copied LHC thread (see `lhcThreadSource.ts`),
 * produce the ordered engine commands that make the t3code pane show the same
 * history the way a live claude-lhc session would have recorded it:
 *
 * - every user prompt opens a t3code turn: user message + turn start, then a
 *   `running` session-set naming the turn; prompt-less LHC segment turns fold
 *   into the preceding prompted turn;
 * - each assistant text message is one delta + complete pair;
 * - each tool call closes as one `tool.completed` activity when its result
 *   arrives, classified/titled/summarized by the Claude adapter's own helpers;
 *   calls with no result close as failed when the turn ends;
 * - runtime notes become `context-compaction` (sidecar compaction notes) or
 *   `runtime.note` info activities;
 * - thinking is dropped; image/document blocks keep their text projection and
 *   are reported, never silently discarded;
 * - a turn closes with `ready` (completed) or `interrupted` (source turn still
 *   open or aborted), and the stream ends in a `stopped` session.
 *
 * Timestamps come from the source event clock through a strictly increasing
 * millisecond clock, because the pane orders by string comparison. Ids are
 * deterministic (`lhcImportIds.ts`) and activity sequence numbers are monotonic.
 */
import {
  CommandId,
  isToolLifecycleItemType,
  type OrchestrationCommand,
  type OrchestrationSession,
  type OrchestrationThreadActivity,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  classifyToolItemType,
  summarizeToolRequest,
  titleForTool,
} from "../provider/Layers/ClaudeAdapter.ts";
import {
  deriveImportedActivityId,
  deriveImportedMessageId,
  deriveImportedTurnId,
} from "./lhcImportIds.ts";
import type { LhcSourceBlock, LhcSourceMessage, LhcSourceThread } from "./lhcThreadSource.ts";

export interface LhcHistoryPlanInput {
  readonly source: LhcSourceThread;
  readonly sourceThreadId: string;
  readonly threadId: ThreadId;
  readonly providerName: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly runtimeMode: RuntimeMode;
}

export interface LhcUnsupportedBlock {
  readonly sourceMessageId: string;
  readonly kind: string;
  readonly blockType: string;
  readonly description: string;
}

export interface LhcHistoryReport {
  /** Prompted (folded) turns; becomes the runtime cursor's `turnCount`. */
  readonly turnCount: number;
  readonly userMessages: number;
  readonly assistantMessages: number;
  readonly toolActivities: number;
  readonly noteActivities: number;
  readonly interruptedTail: boolean;
  /** Non-text API blocks whose bytes have no pane mapping yet; text projection kept. */
  readonly unsupportedBlocks: ReadonlyArray<LhcUnsupportedBlock>;
  readonly danglingToolCalls: ReadonlyArray<{
    readonly sourceMessageId: string;
    readonly toolCallId: string;
    readonly toolName: string;
  }>;
  readonly orphanToolResults: ReadonlyArray<{
    readonly sourceMessageId: string;
    readonly toolCallId: string;
  }>;
  readonly skipped: ReadonlyArray<{
    readonly sourceMessageId: string;
    readonly kind: string;
    readonly reason: string;
  }>;
}

export interface LhcHistoryPlan {
  readonly commands: ReadonlyArray<OrchestrationCommand>;
  readonly report: LhcHistoryReport;
}

const DETAIL_LIMIT = 180;
const SUMMARY_LIMIT = 120;

function truncate(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 3)}...` : value;
}

/**
 * Strictly increasing millisecond clock seeded by source timestamps. Same or
 * earlier source stamps advance by one millisecond so pane ordering (string
 * compare on createdAt) matches source event order.
 */
function makeMonotonicClock(): (recordedAt: string) => string {
  let lastMillis: number | null = null;
  return (recordedAt) => {
    const parsed = DateTime.make(recordedAt);
    const base = Option.isSome(parsed)
      ? DateTime.toEpochMillis(parsed.value)
      : (lastMillis ?? 0) + 1;
    const next = lastMillis === null ? base : Math.max(base, lastMillis + 1);
    lastMillis = next;
    return DateTime.formatIso(DateTime.makeUnsafe(next));
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

/** Text projection of a message: block 0 carries the text-shaped form. */
function messageText(message: LhcSourceMessage): string {
  return stringField(message.blocks[0]?.content ?? null, "text");
}

/**
 * Describe a non-text API block for the report: type, media type, and byte
 * size when the payload was offloaded to the blob table.
 */
function describeBlock(block: LhcSourceBlock): string {
  const source = asRecord(block.content.source);
  const mediaType = stringField(source, "media_type");
  const data = asRecord(source?.data);
  const bytes = typeof data?.bytes === "number" ? `${data.bytes} bytes` : "";
  const title = stringField(block.content, "title");
  return [block.blockType, mediaType, bytes, title].filter((part) => part.length > 0).join(" · ");
}

interface CompactNote {
  readonly beforeTokens: number | undefined;
  readonly afterTokens: number | undefined;
}

/** Sidecar compaction notes look like `[lhc compact:auto] trigger context 271k; rebuilt LHC view 51k (70k target).` */
function parseCompactNote(text: string): CompactNote | null {
  if (!/^\[lhc compact:[^\]]*\]/.test(text)) {
    return null;
  }
  const before = /trigger context (\d+)k/.exec(text);
  const after = /rebuilt LHC view (\d+)k/.exec(text);
  return {
    beforeTokens: before ? Number(before[1]) * 1000 : undefined,
    afterTokens: after ? Number(after[1]) * 1000 : undefined,
  };
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}K` : String(tokens);
}

interface PendingToolCall {
  readonly sourceMessageId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
}

export function planLhcHistory(input: LhcHistoryPlanInput): LhcHistoryPlan {
  const { source, sourceThreadId, threadId } = input;
  const clock = makeMonotonicClock();
  const commands: Array<OrchestrationCommand> = [];
  const sourceTurns = new Map(source.turns.map((turn) => [turn.turnId, turn] as const));

  const unsupportedBlocks: Array<LhcUnsupportedBlock> = [];
  const danglingToolCalls: Array<LhcHistoryReport["danglingToolCalls"][number]> = [];
  const orphanToolResults: Array<LhcHistoryReport["orphanToolResults"][number]> = [];
  const skipped: Array<LhcHistoryReport["skipped"][number]> = [];
  let turnCount = 0;
  let userMessages = 0;
  let assistantMessages = 0;
  let toolActivities = 0;
  let noteActivities = 0;
  let interruptedTail = false;
  let sequence = 0;

  let activeTurnId: TurnId | null = null;
  let lastSourceTurnId: string | null = null;
  let lastRecordedAt = "";
  const pendingTools = new Map<string, PendingToolCall>();

  const commandId = () =>
    CommandId.make(
      `server:thread-import:${threadId}:${String(commands.length + 1).padStart(6, "0")}`,
    );

  const sessionSet = (
    status: OrchestrationSession["status"],
    turnId: TurnId | null,
    at: string,
  ) => {
    commands.push({
      type: "thread.session.set",
      commandId: commandId(),
      threadId,
      session: {
        threadId,
        status,
        providerName: input.providerName,
        providerInstanceId: input.providerInstanceId,
        runtimeMode: input.runtimeMode,
        activeTurnId: turnId,
        lastError: null,
        updatedAt: at,
      },
      createdAt: at,
    });
  };

  const appendActivity = (
    activity: Omit<OrchestrationThreadActivity, "turnId" | "sequence">,
    at: string,
  ) => {
    sequence += 1;
    commands.push({
      type: "thread.activity.append",
      commandId: commandId(),
      threadId,
      activity: { ...activity, turnId: activeTurnId, sequence },
      createdAt: at,
    });
  };

  const toolActivity = (
    call: PendingToolCall,
    result: { readonly content: string; readonly isError: boolean } | null,
    at: string,
  ) => {
    const classified = classifyToolItemType(call.toolName, call.input);
    const itemType = isToolLifecycleItemType(classified) ? classified : "dynamic_tool_call";
    const title = titleForTool(itemType);
    const detail = summarizeToolRequest(call.toolName, call.input);
    appendActivity(
      {
        id: deriveImportedActivityId(sourceThreadId, `tool:${call.toolCallId}`),
        tone: "tool",
        kind: "tool.completed",
        summary: title,
        payload: {
          itemType,
          toolCallId: call.toolCallId,
          status: result === null || result.isError ? "failed" : "completed",
          title,
          detail:
            result === null
              ? "No result recorded before the turn ended"
              : truncate(detail, DETAIL_LIMIT),
          data: {
            toolName: call.toolName,
            input: call.input,
            ...(result === null
              ? {}
              : {
                  result: {
                    type: "tool_result",
                    tool_use_id: call.toolCallId,
                    content: result.content,
                    is_error: result.isError,
                  },
                }),
          },
        },
        createdAt: at,
      },
      at,
    );
    toolActivities += 1;
  };

  const closeTurn = () => {
    if (activeTurnId === null) {
      return;
    }
    for (const call of pendingTools.values()) {
      danglingToolCalls.push({
        sourceMessageId: call.sourceMessageId,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
      });
      toolActivity(call, null, clock(lastRecordedAt));
    }
    pendingTools.clear();
    const sourceTurn = lastSourceTurnId === null ? undefined : sourceTurns.get(lastSourceTurnId);
    const interrupted = sourceTurn?.status === "open" || sourceTurn?.outcome === "aborted";
    sessionSet(interrupted ? "interrupted" : "ready", null, clock(lastRecordedAt));
    activeTurnId = null;
    return interrupted;
  };

  for (const message of source.messages) {
    for (const block of message.blocks.slice(1)) {
      if (
        (message.kind === "user_prompt" || message.kind === "tool_result") &&
        block.blockType !== "text"
      ) {
        unsupportedBlocks.push({
          sourceMessageId: message.messageId,
          kind: message.kind,
          blockType: block.blockType,
          description: describeBlock(block),
        });
      }
    }
    const head = message.blocks[0]?.content ?? {};
    switch (message.kind) {
      case "user_prompt": {
        closeTurn();
        const turnId = deriveImportedTurnId(sourceThreadId, message.messageId);
        const at = clock(message.recordedAt);
        commands.push({
          type: "thread.turn.start",
          commandId: commandId(),
          threadId,
          message: {
            messageId: deriveImportedMessageId(sourceThreadId, message.messageId),
            role: "user",
            text: messageText(message),
            attachments: [],
          },
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          createdAt: at,
        });
        activeTurnId = turnId;
        sessionSet("running", turnId, clock(message.recordedAt));
        turnCount += 1;
        userMessages += 1;
        break;
      }
      case "assistant_text": {
        const text = messageText(message);
        if (text.trim().length === 0) {
          skipped.push({
            sourceMessageId: message.messageId,
            kind: message.kind,
            reason: "empty assistant text",
          });
          break;
        }
        const messageId = deriveImportedMessageId(sourceThreadId, message.messageId);
        const turn = activeTurnId === null ? {} : { turnId: activeTurnId };
        commands.push({
          type: "thread.message.assistant.delta",
          commandId: commandId(),
          threadId,
          messageId,
          delta: text,
          ...turn,
          createdAt: clock(message.recordedAt),
        });
        commands.push({
          type: "thread.message.assistant.complete",
          commandId: commandId(),
          threadId,
          messageId,
          ...turn,
          createdAt: clock(message.recordedAt),
        });
        assistantMessages += 1;
        break;
      }
      case "assistant_thinking":
        // Thinking never reaches the pane; the sidecar replays it from the record.
        break;
      case "tool_call": {
        const toolCallId = stringField(head, "toolCallId");
        const toolName = stringField(head, "toolName") || "tool";
        if (toolCallId.length === 0) {
          skipped.push({
            sourceMessageId: message.messageId,
            kind: message.kind,
            reason: "tool call without toolCallId",
          });
          break;
        }
        pendingTools.set(toolCallId, {
          sourceMessageId: message.messageId,
          toolCallId,
          toolName,
          input: asRecord(head.arguments) ?? {},
        });
        break;
      }
      case "tool_result": {
        const toolCallId = stringField(head, "toolCallId");
        const call = pendingTools.get(toolCallId);
        const result = {
          content: stringField(head, "content"),
          isError: head.isError === true,
        };
        if (call === undefined) {
          orphanToolResults.push({ sourceMessageId: message.messageId, toolCallId });
          toolActivity(
            {
              sourceMessageId: message.messageId,
              toolCallId: toolCallId.length > 0 ? toolCallId : `orphan:${message.messageId}`,
              toolName: "tool",
              input: {},
            },
            result,
            clock(message.recordedAt),
          );
          break;
        }
        pendingTools.delete(toolCallId);
        toolActivity(call, result, clock(message.recordedAt));
        break;
      }
      case "runtime_note": {
        const text = messageText(message);
        const at = clock(message.recordedAt);
        const compact = parseCompactNote(text);
        if (compact !== null) {
          const { beforeTokens, afterTokens } = compact;
          appendActivity(
            {
              id: deriveImportedActivityId(sourceThreadId, `note:${message.messageId}`),
              tone: "info",
              kind: "context-compaction",
              summary:
                beforeTokens !== undefined && afterTokens !== undefined
                  ? `Compacted context ${formatTokens(beforeTokens)} → ${formatTokens(afterTokens)} tokens`
                  : "Context compacted",
              payload: {
                state: "compacted",
                ...(beforeTokens !== undefined ? { beforeTokens } : {}),
                ...(afterTokens !== undefined ? { afterTokens } : {}),
                detail: text,
              },
              createdAt: at,
            },
            at,
          );
        } else {
          appendActivity(
            {
              id: deriveImportedActivityId(sourceThreadId, `note:${message.messageId}`),
              tone: "info",
              kind: "runtime.note",
              summary:
                text.trim().length > 0 ? truncate(text.trim(), SUMMARY_LIMIT) : "Runtime note",
              payload: { message: text },
              createdAt: at,
            },
            at,
          );
        }
        noteActivities += 1;
        break;
      }
      case "model_change":
      case "thinking_level_change":
      case "compact_continuation_marker": {
        const at = clock(message.recordedAt);
        const summary =
          message.kind === "model_change"
            ? `Model changed: ${stringField(head, "previousModel")} → ${stringField(head, "newModel")}`
            : message.kind === "thinking_level_change"
              ? `Thinking level changed: ${stringField(head, "previousLevel")} → ${stringField(head, "newLevel")}`
              : `Compact continuation (${stringField(head, "cause") || "unknown cause"})`;
        appendActivity(
          {
            id: deriveImportedActivityId(sourceThreadId, `note:${message.messageId}`),
            tone: "info",
            kind: "runtime.note",
            summary: truncate(summary, SUMMARY_LIMIT),
            payload: { message: summary, kind: message.kind, content: head },
            createdAt: at,
          },
          at,
        );
        noteActivities += 1;
        break;
      }
      default:
        skipped.push({
          sourceMessageId: message.messageId,
          kind: message.kind,
          reason: "unknown message kind",
        });
    }
    // Tracked after the switch so a prompt closes the previous turn against
    // the source turn that actually held its last message.
    lastRecordedAt = message.recordedAt;
    lastSourceTurnId = message.turnId;
  }

  if (activeTurnId !== null) {
    interruptedTail = closeTurn() === true;
  }
  if (source.messages.length > 0) {
    sessionSet("stopped", null, clock(lastRecordedAt));
  }

  return {
    commands,
    report: {
      turnCount,
      userMessages,
      assistantMessages,
      toolActivities,
      noteActivities,
      interruptedTail,
      unsupportedBlocks,
      danglingToolCalls,
      orphanToolResults,
      skipped,
    },
  };
}
