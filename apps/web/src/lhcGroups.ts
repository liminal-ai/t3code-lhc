// Fork-only (LHC): client for the roundtable (group-line) proxy (/api/groups/*)
// on this server. Same-origin credentialed fetch: the pairing session cookie is the
// browser's credential; the server adds the console bearer.
import { useEffect, useRef, useState } from "react";
import { resolvePrimaryEnvironmentHttpUrl } from "~/environments/primary";
import {
  lastSeqOf,
  mergeMessages,
  type LhcGroupMember,
  type LhcGroupMessage,
  type LhcGroupSummary,
} from "./lhcGroups.logic";

export interface LhcGroupDetail extends LhcGroupSummary {
  readonly members: ReadonlyArray<LhcGroupMember & { readonly cursorSeq: number }>;
  readonly lastSeq: number;
}

export interface LhcGroupPostResult {
  readonly seq: number | null;
  readonly wakes: ReadonlyArray<{ jobId: string; memberId: string }>;
}

export class LhcGroupsApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "LhcGroupsApiError";
    this.status = status;
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function request<T>(
  fetchFn: FetchLike,
  path: string,
  init?: RequestInit,
  signal?: AbortSignal,
  searchParams?: Record<string, string>,
): Promise<T> {
  // The query travels separately: the resolver assigns `pathname`, which would encode a `?`.
  const response = await fetchFn(resolvePrimaryEnvironmentHttpUrl(path, searchParams), {
    credentials: "include",
    ...init,
    ...(signal ? { signal } : {}),
  });
  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) detail = body.error;
    } catch {
      // non-JSON error body: the status line is the best we have
    }
    throw new LhcGroupsApiError(response.status, detail);
  }
  return (await response.json()) as T;
}

export function makeLhcGroupsClient(fetchFn: FetchLike = (input, init) => fetch(input, init)) {
  return {
    list: (signal?: AbortSignal) =>
      request<ReadonlyArray<LhcGroupSummary>>(fetchFn, "/api/groups", undefined, signal),
    /** Group detail with cursors; a console without the detail route (404) falls back to the list. */
    detail: async (groupId: string, signal?: AbortSignal): Promise<LhcGroupDetail> => {
      try {
        return await request<LhcGroupDetail>(
          fetchFn,
          `/api/groups/${encodeURIComponent(groupId)}`,
          undefined,
          signal,
        );
      } catch (err) {
        if (!(err instanceof LhcGroupsApiError && err.status === 404)) throw err;
        const summary = (
          await request<ReadonlyArray<LhcGroupSummary>>(fetchFn, "/api/groups", undefined, signal)
        ).find((group) => group.id === groupId);
        if (!summary) throw err;
        return {
          ...summary,
          members: summary.members.map((member) => ({ ...member, cursorSeq: 0 })),
          lastSeq: 0,
        };
      }
    },
    messages: (groupId: string, since: number, signal?: AbortSignal) =>
      request<{ messages: ReadonlyArray<LhcGroupMessage>; lastSeq: number }>(
        fetchFn,
        `/api/groups/${encodeURIComponent(groupId)}/messages`,
        undefined,
        signal,
        { since: String(since) },
      ),
    /** `wake` = default recipients; the console unions them with the tags in the text. */
    post: (groupId: string, text: string, clientId: string, wake: ReadonlyArray<string> = []) =>
      request<LhcGroupPostResult>(fetchFn, `/api/groups/${encodeURIComponent(groupId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(wake.length ? { text, id: clientId, wake } : { text, id: clientId }),
      }),
  };
}

export type LhcGroupsClient = ReturnType<typeof makeLhcGroupsClient>;
export const lhcGroupsClient: LhcGroupsClient = makeLhcGroupsClient();

/** List poll: fast while anything is working or a roundtable page is open, else relaxed. */
const LIST_POLL_FAST_MS = 5_000;
const LIST_POLL_MS = 15_000;
let sendCounter = 0;
const pageNonce =
  Date.now().toString(36).slice(-4) + performance.now().toString(36).replace(".", "").slice(-4);
const TRANSCRIPT_POLL_MS = 2_000;

/**
 * The console's groups; null until the first answer, [] when none. Polls every
 * 5s while `fast` (a roundtable page is open) or any group reports a working
 * member, else every 15s.
 */
export function useLhcGroups(fast = false): {
  groups: ReadonlyArray<LhcGroupSummary> | null;
  error: string | null;
} {
  const [groups, setGroups] = useState<ReadonlyArray<LhcGroupSummary> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fastRef = useRef(fast);
  useEffect(() => {
    fastRef.current = fast;
  }, [fast]);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let anyWorking = false;
    const tick = async () => {
      try {
        const list = await lhcGroupsClient.list(controller.signal);
        anyWorking = list.some((group) => (group.working?.length ?? 0) > 0);
        setGroups(list);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted) return;
        // 404 means a server without the proxy (stock build): no groups, no noise.
        if (err instanceof LhcGroupsApiError && err.status === 404) setGroups([]);
        else setError(err instanceof Error ? err.message : String(err));
      }
      if (!controller.signal.aborted) {
        const delay = fastRef.current || anyWorking ? LIST_POLL_FAST_MS : LIST_POLL_MS;
        timer = setTimeout(() => void tick(), delay);
      }
    };
    void tick();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, []);
  return { groups, error };
}

export interface LhcGroupTranscriptState {
  readonly group: LhcGroupDetail | null;
  readonly messages: ReadonlyArray<LhcGroupMessage>;
  readonly error: string | null;
  readonly loaded: boolean;
  /** Post an owner message; the transcript refreshes on the next poll (forced immediately). */
  readonly send: (text: string, wake?: ReadonlyArray<string>) => Promise<LhcGroupPostResult>;
}

interface TranscriptData {
  readonly groupId: string;
  readonly group: LhcGroupDetail | null;
  readonly messages: ReadonlyArray<LhcGroupMessage>;
  readonly error: string | null;
  readonly loaded: boolean;
}
const emptyTranscript = (groupId: string): TranscriptData => ({
  groupId,
  group: null,
  messages: [],
  error: null,
  loaded: false,
});

/** One group's transcript, polled every 2s with a since-cursor, plus its detail (cursors). */
export function useLhcGroupTranscript(groupId: string): LhcGroupTranscriptState {
  const [data, setData] = useState<TranscriptData>(() => emptyTranscript(groupId));
  // A group switch renders empty until its first poll lands; no reset inside the effect.
  const current = data.groupId === groupId ? data : emptyTranscript(groupId);
  const sinceRef = useRef(0);
  const pokeRef = useRef<() => void>(() => {});

  useEffect(() => {
    sinceRef.current = 0;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let detailEvery = 0;
    let anyoneWorking = false;
    const update = (patch: Partial<TranscriptData>) =>
      setData((previous) => ({
        ...(previous.groupId === groupId ? previous : emptyTranscript(groupId)),
        ...patch,
        groupId,
      }));
    const tick = async () => {
      if (controller.signal.aborted) return;
      try {
        const page = await lhcGroupsClient.messages(groupId, sinceRef.current, controller.signal);
        if (page.messages.length) {
          sinceRef.current = Math.max(sinceRef.current, lastSeqOf(page.messages));
          setData((previous) => {
            const base = previous.groupId === groupId ? previous : emptyTranscript(groupId);
            return { ...base, messages: mergeMessages(base.messages, page.messages) };
          });
        }
        // The detail carries cursors and who is working; refresh it every poll while
        // anyone is working (so the pending rows clear promptly), else every 5th or on new lines.
        if (detailEvery % 5 === 0 || page.messages.length || anyoneWorking) {
          const group = await lhcGroupsClient.detail(groupId, controller.signal);
          anyoneWorking = group.members.some((member) => member.activity?.state === "working");
          update({ group });
        }
        detailEvery += 1;
        update({ error: null, loaded: true });
      } catch (err) {
        if (controller.signal.aborted) return;
        update({ error: err instanceof Error ? err.message : String(err), loaded: true });
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void tick(), TRANSCRIPT_POLL_MS);
    };
    pokeRef.current = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      void tick();
    };
    void tick();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
      pokeRef.current = () => {};
    };
  }, [groupId]);

  const send = async (text: string, wake: ReadonlyArray<string> = []) => {
    // Dedupe key for the console (web:<id>); uniqueness per page session is enough.
    sendCounter += 1;
    const clientId = `${Date.now().toString(36)}-${sendCounter.toString(36)}-${pageNonce}`;
    const result = await lhcGroupsClient.post(groupId, text, clientId, wake);
    pokeRef.current();
    return result;
  };
  return {
    group: current.group,
    messages: current.messages,
    error: current.error,
    loaded: current.loaded,
    send,
  };
}
