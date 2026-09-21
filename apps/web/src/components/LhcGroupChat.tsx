// Fork-only (LHC): group chat page pieces. The transcript renders the console's
// lines oldest-first: the owner's lines right-aligned, member replies as
// markdown under the member's name, and a "read to here" marker at each
// member's cursor. The composer posts through the proxy with @-autocomplete
// over member keys and a wake preview that follows the console's tag rule.
import { SendIcon } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useCallback, useMemo, useRef, useState } from "react";
import {
  applyMention,
  mentionCandidates,
  mentionQueryAt,
  OWNER_SENDER_ID,
  readMarkersAt,
  wakePreviewLabel,
  type LhcGroupMember,
  type LhcGroupMessage,
  type MentionQuery,
} from "../lhcGroups.logic";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

export function LhcGroupTranscript(props: {
  readonly messages: ReadonlyArray<LhcGroupMessage>;
  readonly members: ReadonlyArray<LhcGroupMember>;
  /** Injected so tests render without the chat markdown stack. */
  readonly renderMarkdown: (text: string) => ReactNode;
  readonly onOpenReply?: ((message: LhcGroupMessage) => void) | undefined;
}) {
  const { messages, members, renderMarkdown } = props;
  return (
    <ol className="flex flex-col gap-3 px-3 py-4 sm:px-6" data-testid="lhc-group-transcript">
      {messages.map((message) => {
        const own = message.senderId === OWNER_SENDER_ID;
        const markers = readMarkersAt(members, message.seq);
        return (
          <li
            key={message.seq}
            data-seq={message.seq}
            data-sender={message.senderId}
            className={cn("flex flex-col gap-1", own ? "items-end" : "items-start")}
          >
            <div
              className={cn(
                "flex items-baseline gap-2 text-xs text-secondary-label",
                own && "flex-row-reverse",
              )}
            >
              <span className={cn("font-medium", own ? "text-primary" : "text-foreground/80")}>
                {message.senderLabel}
              </span>
              <time dateTime={message.at}>{formatRelativeTimeLabel(message.at)}</time>
            </div>
            {own ? (
              <div className="max-w-[85%] whitespace-pre-wrap rounded-2xl rounded-tr-sm bg-primary/10 px-3 py-2 text-sm text-foreground sm:max-w-[70%]">
                {message.text}
              </div>
            ) : (
              <div className="max-w-full min-w-0 rounded-2xl rounded-tl-sm bg-foreground/5 px-3 py-2 text-sm sm:max-w-[85%]">
                {renderMarkdown(message.text)}
              </div>
            )}
            {markers.length ? (
              <div
                className="text-[10px] text-secondary-label"
                data-testid={`lhc-group-read-marker-${message.seq}`}
              >
                {markers.map((m) => m.label).join(", ")} read to here
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export function LhcGroupComposer(props: {
  readonly members: ReadonlyArray<LhcGroupMember>;
  readonly onSend: (text: string) => Promise<unknown>;
  readonly disabled?: boolean | undefined;
}) {
  const { members, onSend, disabled } = props;
  const [text, setText] = useState("");
  const [caret, setCaret] = useState(0);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  // Candidate cursor, reset whenever the typed query changes (derived, no effect).
  const [candidate, setCandidate] = useState<{ query: string | undefined; index: number }>({
    query: undefined,
    index: 0,
  });
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const mention: MentionQuery | null = useMemo(() => mentionQueryAt(text, caret), [text, caret]);
  const candidates = useMemo(
    () => (mention ? mentionCandidates(members, mention.query) : []),
    [mention, members],
  );
  const preview = useMemo(() => wakePreviewLabel(text, members), [text, members]);
  const mentionQuery = mention?.query;
  const candidateIndex = candidate.query === mentionQuery ? candidate.index : 0;
  const setCandidateIndex = (update: (index: number) => number) =>
    setCandidate({ query: mentionQuery, index: update(candidateIndex) });

  const syncCaret = useCallback(() => {
    const element = inputRef.current;
    if (element) setCaret(element.selectionStart ?? element.value.length);
  }, []);

  const pick = useCallback(
    (key: string) => {
      if (!mention) return;
      const next = applyMention(text, mention, key);
      setText(next.text);
      setCaret(next.caret);
      requestAnimationFrame(() => {
        const element = inputRef.current;
        if (element) {
          element.focus();
          element.setSelectionRange(next.caret, next.caret);
        }
      });
    },
    [mention, text],
  );

  const submit = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || sending || disabled) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(trimmed);
      setText("");
      setCaret(0);
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
      inputRef.current?.focus();
    }
  }, [disabled, onSend, sending, text]);

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (candidates.length && mention) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setCandidateIndex((i) => (i + 1) % candidates.length);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setCandidateIndex((i) => (i - 1 + candidates.length) % candidates.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.shiftKey)) {
        event.preventDefault();
        pick(candidates[candidateIndex]?.key ?? candidates[0]!.key);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setCaret(-1);
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  };

  return (
    <form
      className="flex flex-col gap-1.5 border-t border-border bg-background px-3 py-2 sm:px-6"
      data-testid="lhc-group-composer"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="relative">
        {candidates.length && mention ? (
          <ul
            role="listbox"
            data-testid="lhc-group-mention-menu"
            className="absolute bottom-full left-0 z-10 mb-1 min-w-40 overflow-hidden rounded-md border border-border bg-popover text-sm shadow-md"
          >
            {candidates.map((candidate, index) => (
              <li key={candidate.key}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === candidateIndex}
                  className={cn(
                    "flex w-full items-center gap-2 px-2.5 py-1.5 text-left",
                    index === candidateIndex ? "bg-foreground/10" : "hover:bg-foreground/5",
                  )}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => pick(candidate.key)}
                >
                  <span className="font-medium">@{candidate.key}</span>
                  <span className="text-secondary-label">{candidate.label}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            value={text}
            rows={2}
            disabled={disabled}
            placeholder={`@${members[0]?.id ?? "member"} … or @all`}
            aria-label="Message the group"
            data-testid="lhc-group-input"
            className="max-h-40 min-h-10 flex-1 resize-none text-sm"
            onChange={(event) => {
              setText(event.target.value);
              setCaret(event.target.selectionStart ?? event.target.value.length);
            }}
            onKeyDown={onKeyDown}
            onKeyUp={syncCaret}
            onClick={syncCaret}
          />
          <Button
            type="submit"
            size="sm"
            aria-label="Send"
            disabled={disabled || sending || !text.trim()}
            data-testid="lhc-group-send"
          >
            <SendIcon className="size-4" />
          </Button>
        </div>
      </div>
      <div
        className={cn("min-h-4 text-xs", sendError ? "text-destructive" : "text-secondary-label")}
        data-testid="lhc-group-wake-preview"
      >
        {sendError ?? preview}
      </div>
    </form>
  );
}
