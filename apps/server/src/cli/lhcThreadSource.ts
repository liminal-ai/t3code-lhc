// @effect-diagnostics nodeBuiltinImport:off - reads a copied LHC thread database directly; t3code deliberately has no LHC SDK dependency.
/**
 * Read-only reader for a *copy* of a cc-lhc thread database.
 *
 * The importer never opens a live LHC record: the caller supplies a path to a
 * SQLite backup/VACUUM copy. Only the raw-history tables are read (thread
 * metadata, turns, messages with their blocks, and the event clock); bands,
 * derivations, and blobs are the sidecar's concern and stay untouched.
 */
import * as NodeSqlite from "node:sqlite";

import * as Schema from "effect/Schema";

export interface LhcSourceBlock {
  readonly blockType: string;
  readonly content: Record<string, unknown>;
}

export interface LhcSourceMessage {
  readonly messageId: string;
  readonly kind: string;
  readonly turnId: string;
  readonly sourceEventOrder: number;
  readonly recordedAt: string;
  readonly blocks: ReadonlyArray<LhcSourceBlock>;
}

export interface LhcSourceTurn {
  readonly turnId: string;
  readonly turnOrder: number;
  readonly status: "open" | "closed";
  readonly outcome: "completed" | "aborted" | null;
  readonly outcomeReason: string | null;
}

export interface LhcSourceThread {
  readonly threadId: string;
  readonly turns: ReadonlyArray<LhcSourceTurn>;
  readonly messages: ReadonlyArray<LhcSourceMessage>;
}

export class LhcSourceReadError extends Error {
  override readonly name = "LhcSourceReadError";
  readonly path: string;
  readonly detail: string;
  constructor(path: string, detail: string) {
    super(`Cannot read LHC thread copy at ${path}: ${detail}`);
    this.path = path;
    this.detail = detail;
  }
}

const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const MetadataRow = Schema.Struct({ thread_id: Schema.String });
const TurnRow = Schema.Struct({
  turn_id: Schema.String,
  turn_order: Schema.Number,
  status: Schema.Literals(["open", "closed"]),
  outcome: Schema.NullOr(Schema.Literals(["completed", "aborted"])),
  outcome_reason: Schema.NullOr(Schema.String),
});
const MessageRow = Schema.Struct({
  message_id: Schema.String,
  kind: Schema.String,
  turn_id: Schema.String,
  source_event_order: Schema.Number,
  recorded_at: Schema.String,
});
const BlockRow = Schema.Struct({
  message_id: Schema.String,
  block_index: Schema.Number,
  block_type: Schema.String,
  content: Schema.String,
});
const decodeMetadataRows = Schema.decodeUnknownSync(Schema.Array(MetadataRow));
const decodeTurnRows = Schema.decodeUnknownSync(Schema.Array(TurnRow));
const decodeMessageRows = Schema.decodeUnknownSync(Schema.Array(MessageRow));
const decodeBlockRows = Schema.decodeUnknownSync(Schema.Array(BlockRow));

/**
 * Load the raw history of a copied LHC thread. Synchronous and read-only;
 * throws `LhcSourceReadError` when the file is not an LHC thread record.
 */
export function readLhcThreadSource(path: string): LhcSourceThread {
  let db: NodeSqlite.DatabaseSync;
  try {
    db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    throw new LhcSourceReadError(path, cause instanceof Error ? cause.message : String(cause));
  }
  try {
    const metadata = decodeMetadataRows(
      db.prepare("SELECT thread_id FROM thread_metadata WHERE id = 1").all(),
    );
    const threadId = metadata[0]?.thread_id;
    if (threadId === undefined || threadId.length === 0) {
      throw new LhcSourceReadError(path, "thread_metadata has no thread id");
    }
    const turns = decodeTurnRows(
      db
        .prepare(
          `SELECT turn_id, turn_order, status, outcome, outcome_reason
           FROM turns WHERE deleted_at IS NULL ORDER BY turn_order ASC`,
        )
        .all(),
    ).map((row) => ({
      turnId: row.turn_id,
      turnOrder: row.turn_order,
      status: row.status,
      outcome: row.outcome,
      outcomeReason: row.outcome_reason,
    }));
    const blocksByMessage = new Map<string, LhcSourceBlock[]>();
    for (const row of decodeBlockRows(
      db
        .prepare(
          `SELECT message_id, block_index, block_type, content
           FROM message_block ORDER BY message_id ASC, block_index ASC`,
        )
        .all(),
    )) {
      const list = blocksByMessage.get(row.message_id) ?? [];
      list.push({ blockType: row.block_type, content: decodeRecord(row.content) });
      blocksByMessage.set(row.message_id, list);
    }
    const messages = decodeMessageRows(
      db
        .prepare(
          `SELECT m.message_id, m.kind, m.turn_id, m.source_event_order, e.recorded_at
           FROM message m JOIN event e ON e.event_order = m.source_event_order
           WHERE m.deleted_at IS NULL ORDER BY m.source_event_order ASC`,
        )
        .all(),
    ).map((row) => ({
      messageId: row.message_id,
      kind: row.kind,
      turnId: row.turn_id,
      sourceEventOrder: row.source_event_order,
      recordedAt: row.recorded_at,
      blocks: blocksByMessage.get(row.message_id) ?? [],
    }));
    return { threadId, turns, messages };
  } catch (cause) {
    if (cause instanceof LhcSourceReadError) {
      throw cause;
    }
    throw new LhcSourceReadError(path, cause instanceof Error ? cause.message : String(cause));
  } finally {
    db.close();
  }
}
