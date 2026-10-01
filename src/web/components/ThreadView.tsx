import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  archiveThread,
  bulkUpdateThreads,
  discardDraft,
  fetchThread,
  markRead,
  reviseDraft,
  sendReply,
  unarchiveThread,
} from "../api";
import type { Draft, Message } from "../../shared/types";
import {
  deriveAgentDraftStatus,
  type AgentDraftStatus,
} from "../../shared/agent-status";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { formatTime, splitQuotedTail } from "../lib";
import { EmailAvatar } from "./EmailAvatar";
import { EmailHtmlBody } from "./EmailHtmlBody";
import {
  ArchiveIcon,
  ArrowLeftIcon,
  InboxIcon,
  MailUnreadIcon,
  PaperclipIcon,
  SendIcon,
  SparklesIcon,
  TagIcon,
  XIcon,
} from "./Icons";
import { LinkifiedText } from "./LinkifiedText";

export function ThreadView(props: {
  threadId: number;
  deferMarkRead?: boolean;
  onBack: () => void;
  onMoved: () => void;
}) {
  const queryClient = useQueryClient();
  const [replyText, setReplyText] = useState("");
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [sendNotice, setSendNotice] = useState<string | null>(null);
  const [failedAttemptKey, setFailedAttemptKey] = useState<string | null>(null);
  const [usedDraftId, setUsedDraftId] = useState<number | null>(null);
  const [instructionOpen, setInstructionOpen] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [undoState, setUndoState] = useState<{ text: string; draftId: number | null } | null>(null);
  const seenDraftIds = useRef(new Set<number>());
  const instructionRef = useRef<HTMLInputElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const markedRead = useRef<number | null>(null);
  const conversationRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const attemptIds = useRef(new Map<string, { text: string; id: string }>());

  const detail = useQuery({
    queryKey: ["thread", props.threadId],
    queryFn: () => fetchThread(props.threadId),
    refetchInterval: (query) => {
      const status = query.state.data?.draft_run?.status;
      return status === "queued" || status === "generating" ? 3_000 : 30_000;
    },
  });

  const markThreadRead = useCallback(() => {
    if (markedRead.current === props.threadId) return;
    markedRead.current = props.threadId;
    markRead(props.threadId).then(() => {
      queryClient.invalidateQueries({ queryKey: ["threads"] });
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    }).catch(() => {
      // Allow the next interaction to retry an unsuccessful automatic read.
      markedRead.current = null;
    });
  }, [props.threadId, queryClient]);

  useEffect(() => {
    if (!props.deferMarkRead) markThreadRead();
  }, [props.deferMarkRead, markThreadRead]);

  useEffect(() => {
    setReplyText("");
    setPendingFiles([]);
    setSendNotice(null);
    setFailedAttemptKey(null);
    setUsedDraftId(null);
    seenDraftIds.current.clear();
    attemptIds.current.clear();
  }, [props.threadId]);

  useEffect(() => {
    if (!detail.data) return;
    requestAnimationFrame(() => {
      const container = conversationRef.current;
      if (container) container.scrollTop = container.scrollHeight;
    });
  }, [detail.data, props.threadId]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["thread", props.threadId] });
    queryClient.invalidateQueries({ queryKey: ["threads"] });
    queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
  };

  const reply = useMutation({
    mutationFn: (args: {
      text: string;
      attemptId: string;
      attemptKey: string;
      draftId?: number;
      files?: File[];
    }) =>
      sendReply(props.threadId, args.text, args.attemptId, args.draftId, args.files ?? []),
    onSuccess: (result, args) => {
      if (result.status === "sent") {
        setReplyText("");
        setPendingFiles([]);
        setUsedDraftId(null);
        setUndoState(null);
        setInstructionOpen(false);
        setInstruction("");
      }
      setFailedAttemptKey(null);
      setSendNotice(
        result.status === "sending"
          ? "The provider accepted this send request, but confirmation is still pending. It will not be sent again automatically."
          : null,
      );
      invalidateAll();
    },
    onError: (_error, args) => setFailedAttemptKey(args.attemptKey),
  });

  const discard = useMutation({
    mutationFn: (draftId: number) => discardDraft(draftId),
    onSuccess: (_result, draftId) => {
      seenDraftIds.current.add(draftId);
      setReplyText("");
      setUsedDraftId(null);
      setUndoState(null);
      invalidateAll();
    },
  });

  const revise = useMutation({
    mutationFn: (args: { instruction: string; currentText: string; previousDraftId: number | null }) =>
      reviseDraft(props.threadId, args.instruction, args.currentText),
    onSuccess: (next, args) => {
      // Mark it seen so polling does not treat the revision as a newly arrived draft.
      seenDraftIds.current.add(next.id);
      setUndoState({ text: args.currentText, draftId: args.previousDraftId });
      setReplyText(next.text_body);
      setUsedDraftId(next.id);
      invalidateAll();
    },
    // The input is disabled while pending, so focus has to be put back for the next tweak.
    onSettled: () => requestAnimationFrame(() => instructionRef.current?.focus()),
  });

  const moveThread = useMutation({
    mutationFn: (action: "archive" | "unarchive") =>
      action === "archive" ? archiveThread(props.threadId) : unarchiveThread(props.threadId),
    onSuccess: () => {
      invalidateAll();
      props.onMoved();
    },
  });

  const markUnread = useMutation({
    mutationFn: () => bulkUpdateThreads([props.threadId], "unread"),
    onSuccess: () => {
      invalidateAll();
      props.onBack();
    },
  });

  const draft = detail.data?.drafts.at(-1) ?? null;

  useEffect(() => {
    if (!draft || seenDraftIds.current.has(draft.id)) return;
    // Consider each draft once: polling must not restore text the user cleared
    // or replace a reply they were already writing when the draft arrived.
    seenDraftIds.current.add(draft.id);
    if (replyText.trim() || reply.isPending || discard.isPending || revise.isPending) return;
    setReplyText(draft.text_body);
    setUsedDraftId(draft.id);
  }, [draft, replyText, reply.isPending, discard.isPending, revise.isPending]);

  if (detail.isLoading) return <ThreadViewSkeleton onBack={props.onBack} />;

  if (detail.isError || !detail.data) {
    return (
      <div className="flex h-full flex-col bg-canvas">
        <div className="flex h-16 items-center border-b bg-background px-4 md:hidden">
          <Button
            variant="ghost"
            size="icon"
            onClick={props.onBack}
            className="-ml-1"
            aria-label="Back to conversations"
          >
            <ArrowLeftIcon className="h-5 w-5" />
          </Button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
            <InboxIcon className="h-[18px] w-[18px]" />
          </span>
          <p className="mt-3 text-[13px] font-medium text-foreground">Couldn’t open this conversation</p>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            It may have been archived or deleted, or the connection dropped.
          </p>
          <Button variant="outline" onClick={() => detail.refetch()} className="mt-4">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  const { thread, messages, drafts } = detail.data;
  const agentStatus = deriveAgentDraftStatus({
    pendingDraftCount: drafts.length,
    runStatus: detail.data.draft_run?.status ?? null,
    agentMode: thread.mailbox_agent_mode,
    latestInboundIsAutomated: Boolean(thread.latest_inbound_is_auto_submitted),
    lastMessageDirection: thread.last_message_direction,
  });

  const attemptFor = (key: string, text: string) => {
    const existing = attemptIds.current.get(key);
    if (existing?.text === text) return existing.id;
    const id = crypto.randomUUID();
    attemptIds.current.set(key, { text, id });
    return id;
  };

  const submitReply = () => {
    const text = replyText.trim();
    if ((text || pendingFiles.length > 0) && !reply.isPending && !discard.isPending && !revise.isPending) {
      const fingerprint = `${text} ${pendingFiles.map((file) => `${file.name}:${file.size}`).join(",")}`;
      const attemptKey = usedDraftId === null ? "manual" : `draft-${usedDraftId}`;
      reply.mutate({
        text,
        files: pendingFiles,
        draftId: usedDraftId ?? undefined,
        attemptId: attemptFor(attemptKey, fingerprint),
        attemptKey,
      });
    }
  };

  const applyDraft = (next: Draft) => {
    seenDraftIds.current.add(next.id);
    setReplyText(next.text_body);
    setUsedDraftId(next.id);
    setUndoState(null);
  };

  const composerBusy = reply.isPending || discard.isPending || revise.isPending;

  const submitInstruction = () => {
    if (composerBusy) return;
    revise.mutate({ instruction: instruction.trim(), currentText: replyText, previousDraftId: usedDraftId });
  };

  const closeInstruction = () => {
    setInstructionOpen(false);
    revise.reset();
    replyRef.current?.focus();
  };

  const undoRevision = () => {
    if (!undoState) return;
    setReplyText(undoState.text);
    setUsedDraftId(undoState.draftId);
    setUndoState(null);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    // Clipboard files are only readable during the paste event.
    const files = Array.from(list);
    setPendingFiles((current) => [...current, ...files].slice(0, 10));
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div
      className="flex h-full min-w-0 flex-col bg-canvas"
      onPointerDown={markThreadRead}
      onKeyDown={markThreadRead}
      onWheel={markThreadRead}
    >
      <header className="flex min-h-16 shrink-0 items-center gap-3 border-b bg-background px-4 py-2.5 md:px-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={props.onBack}
          className="-ml-1 md:hidden"
          aria-label="Back to conversations"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1
            className="truncate text-[15px] font-semibold tracking-[-0.015em] text-foreground"
            title={thread.subject || undefined}
          >
            {thread.subject || "(no subject)"}
          </h1>
          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{thread.mailbox_address}</span>
            <span aria-hidden="true">·</span>
            <span className="shrink-0 tabular-nums">
              {thread.message_count} {thread.message_count === 1 ? "message" : "messages"}
            </span>
            {thread.labels.length > 0 && (
              <span className="ml-1 hidden min-w-0 items-center gap-1 overflow-hidden sm:flex">
                {thread.labels.map((label) => (
                  <Badge
                    key={label.id}
                    variant="outline"
                    className="h-5 shrink-0 gap-1 rounded-md px-1.5 text-[11px] font-normal text-foreground/75"
                  >
                    <TagIcon className="h-3 w-3 text-muted-foreground" />
                    {label.name}
                  </Badge>
                ))}
              </span>
            )}
          </div>
        </div>
        <Button
          variant="outline"
          size="icon"
          title="Mark unread"
          aria-label="Mark conversation as unread"
          disabled={markUnread.isPending || moveThread.isPending}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onClick={() => markUnread.mutate()}
          className="shrink-0"
        >
          <MailUnreadIcon className="h-4 w-4" />
        </Button>
        {thread.status === "archived" ? (
          <Button
            variant="outline"
            onClick={() => moveThread.mutate("unarchive")}
            disabled={moveThread.isPending || markUnread.isPending}
            aria-label="Move conversation to inbox"
            className="shrink-0"
          >
            <InboxIcon className="h-4 w-4" />
            <span className="hidden sm:inline">
              {moveThread.isPending ? "Moving…" : "Move to inbox"}
            </span>
          </Button>
        ) : (
          <Button
            variant="outline"
            onClick={() => moveThread.mutate("archive")}
            disabled={moveThread.isPending || markUnread.isPending}
            aria-label="Archive conversation"
            className="shrink-0"
          >
            <ArchiveIcon className="h-4 w-4" />
            <span className="hidden sm:inline">
              {moveThread.isPending ? "Archiving…" : "Archive"}
            </span>
          </Button>
        )}
      </header>

      {markUnread.isError && (
        <p role="alert" className="border-b bg-background px-4 py-2 text-sm text-destructive md:px-6">
          Couldn’t mark this conversation as unread. Please try again.
        </p>
      )}

      <div ref={conversationRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mr-auto w-full max-w-[800px] space-y-3 px-4 py-5 sm:px-6 md:py-6">
          {messages.map((message) => (
            <MessageCard key={message.id} message={message} />
          ))}
        </div>
      </div>

      <footer className="shrink-0 bg-canvas pt-1 pb-3 sm:pb-5">
        <div className="mr-auto w-full max-w-[800px] px-4 sm:px-6">
          <Card className="gap-0 py-0 shadow-[0_1px_2px_oklch(0.2_0.012_265/0.04),0_4px_16px_-6px_oklch(0.2_0.012_265/0.08)] transition-shadow focus-within:ring-foreground/25">
            <div className="flex min-h-9 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 py-1 pr-2 pl-3.5 text-xs text-muted-foreground">
              <span className="flex min-w-0 flex-1 basis-48 items-center gap-1.5 py-1">
                <span className="shrink-0">Replying from</span>
                <span className="truncate font-medium text-foreground/80" title={thread.mailbox_address}>
                  {thread.mailbox_address}
                </span>
              </span>
              <DraftAssist
                status={agentStatus}
                draft={draft}
                usingDraft={draft !== null && usedDraftId === draft.id}
                canDraft={messages.some((message) => message.direction === "inbound")}
                error={detail.data.draft_run?.error ?? null}
                busy={discard.isPending}
                disabled={reply.isPending || revise.isPending}
                instructionOpen={instructionOpen}
                canUndo={undoState !== null && !revise.isPending}
                onUse={() => draft && applyDraft(draft)}
                onDiscard={() => draft && discard.mutate(draft.id)}
                onInstruct={() => {
                  setInstructionOpen(true);
                  requestAnimationFrame(() => instructionRef.current?.focus());
                }}
                onUndo={undoRevision}
              />
            </div>
            {instructionOpen && (
              <InstructionBar
                inputRef={instructionRef}
                value={instruction}
                onChange={setInstruction}
                hasReply={replyText.trim().length > 0}
                pending={revise.isPending}
                disabled={reply.isPending || discard.isPending}
                error={revise.error instanceof Error ? revise.error.message : null}
                onSubmit={submitInstruction}
                onClose={closeInstruction}
              />
            )}
            <Textarea
              ref={replyRef}
              value={replyText}
              disabled={composerBusy}
              aria-busy={revise.isPending || undefined}
              onChange={(event) => {
                setReplyText(event.target.value);
                setUndoState(null);
                if (!event.target.value.trim()) setUsedDraftId(null);
              }}
              onPaste={(event) => {
                if (composerBusy || event.clipboardData.files.length === 0) return;
                event.preventDefault();
                addFiles(event.clipboardData.files);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  submitReply();
                }
              }}
              placeholder="Write a reply…"
              rows={3}
              aria-label="Reply"
              className="max-h-[min(30dvh,200px)] min-h-[84px] resize-none overflow-y-auto overscroll-contain rounded-none border-0 bg-transparent px-3.5 py-3 text-sm leading-6 shadow-none transition-opacity duration-300 ease-out focus-visible:ring-0 disabled:bg-transparent aria-busy:opacity-40 md:text-sm"
            />
            {pendingFiles.length > 0 && (
              <div className="flex flex-wrap gap-1.5 px-3.5 pb-1" aria-label="Attachments to send">
                {pendingFiles.map((file, index) => (
                  <span
                    key={`${file.name}-${index}`}
                    className="inline-flex max-w-full items-center gap-1.5 rounded-md border bg-muted/40 py-1 pr-1 pl-2 text-xs text-foreground"
                  >
                    <PaperclipIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">{file.name}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatFileSize(file.size)}
                    </span>
                    <button
                      type="button"
                      aria-label={`Remove ${file.name}`}
                      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                      onClick={() =>
                        setPendingFiles((current) =>
                          current.filter((_, i) => i !== index),
                        )
                      }
                    >
                      <XIcon className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="flex items-center justify-end px-3 pb-3 sm:justify-between">
              <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
                <Kbd>{isMac ? "⌘" : "Ctrl"}</Kbd>
                <Kbd>Enter</Kbd>
                <span className="ml-0.5">to send</span>
              </span>
              <div className="flex items-center gap-1.5">
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => addFiles(event.target.files)}
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  aria-label="Attach files"
                  title="Attach files"
                  disabled={reply.isPending}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <PaperclipIcon className="h-4 w-4" />
                </Button>
                <Button
                  onClick={submitReply}
                  disabled={(!replyText.trim() && pendingFiles.length === 0) || composerBusy}
                >
                  <SendIcon className="h-3.5 w-3.5" />
                  {reply.isPending ? "Sending…" : "Send reply"}
                </Button>
              </div>
            </div>
          </Card>
          {discard.isError && (
            <p role="alert" className="mt-2 text-xs leading-5 text-destructive">
              Couldn’t discard the AI draft. Your text is still here. Try again.
            </p>
          )}
          {reply.isError && (
            <div
              role="alert"
              className="mt-2 flex items-center gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs leading-5 text-destructive"
            >
              <p className="min-w-0 flex-1">
                {reply.error instanceof Error ? reply.error.message : "The reply could not be sent."}
                {" "}Your text is still here. Check Email Logs before creating a new send attempt.
              </p>
              {failedAttemptKey && (
                <Button
                  variant="outline"
                  size="sm"
                  className="shrink-0 text-foreground"
                  onClick={() => {
                    attemptIds.current.delete(failedAttemptKey);
                    setFailedAttemptKey(null);
                    reply.reset();
                  }}
                >
                  New attempt
                </Button>
              )}
            </div>
          )}
          {sendNotice && (
            <div
              role="status"
              className="mt-2 rounded-lg border bg-background px-3 py-2 text-xs leading-5 text-muted-foreground"
            >
              {sendNotice}
            </div>
          )}
        </div>
      </footer>
    </div>
  );
}

function MessageCard({ message }: { message: Message }) {
  const [showQuoted, setShowQuoted] = useState(false);
  const isOutbound = message.direction === "outbound";
  const displayName = isOutbound
    ? message.from_name || message.from_address
    : message.from_name || message.from_address;
  const { main, quoted } = splitQuotedTail(message.text_body ?? "");

  return (
    <Card className="gap-0 p-4 sm:p-5">
      <div className="mb-3 flex items-start gap-3">
        <EmailAvatar
          email={message.from_address}
          label={displayName}
          fallback={message.sent_by === "agent" ? <SparklesIcon className="h-4 w-4" /> : undefined}
          className={`h-9 w-9 text-[13px] ${isOutbound ? "bg-muted text-foreground/70" : ""}`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[13.5px] font-semibold text-foreground">{displayName}</span>
            {message.sent_by === "agent" && <AuthorBadge tone="agent">Agent</AuthorBadge>}
            {isOutbound && message.sent_by === "human" && <AuthorBadge tone="human">You</AuthorBadge>}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {isOutbound ? `to ${JSON.parse(message.to_addresses || "[]").join(", ")}` : message.from_address}
          </div>
        </div>
        <time
          dateTime={message.created_at}
          className="mt-0.5 shrink-0 text-xs tabular-nums text-muted-foreground"
          title={new Date(message.created_at).toLocaleString()}
        >
          {formatTime(message.created_at)}
        </time>
      </div>

      {message.html_body ? (
        <EmailHtmlBody
          html={message.html_body}
          attachments={message.attachments}
          sender={displayName}
        />
      ) : (
        <div className="max-w-[72ch] break-words text-sm leading-6 whitespace-pre-wrap text-foreground">
          <LinkifiedText text={main} />
        </div>
      )}
      {message.attachments.length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2" aria-label="Attachments">
          {message.attachments.map((attachment) => (
            <a
              key={attachment.id}
              href={`/api/attachments/${attachment.id}`}
              download={attachment.filename || undefined}
              className="inline-flex max-w-full items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5 text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <PaperclipIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{attachment.filename || "Attachment"}</span>
              <span className="shrink-0 text-muted-foreground">{formatFileSize(attachment.size)}</span>
            </a>
          ))}
        </div>
      )}
      {!message.html_body && quoted && (
        <div className="mt-3">
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowQuoted((visible) => !visible)}
            aria-expanded={showQuoted}
            className="-ml-2 text-muted-foreground"
          >
            {showQuoted ? "Hide quoted text" : "Show quoted text"}
          </Button>
          {showQuoted && (
            <div className="mt-2 break-words border-l border-border pl-3 text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
              <LinkifiedText text={quoted} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function DraftAssist(props: {
  status: AgentDraftStatus;
  draft: Draft | null;
  usingDraft: boolean;
  canDraft: boolean;
  error: string | null;
  busy: boolean;
  disabled: boolean;
  instructionOpen: boolean;
  canUndo: boolean;
  onUse: () => void;
  onDiscard: () => void;
  onInstruct: () => void;
  onUndo: () => void;
}) {
  const action = (
    label: string,
    onClick: () => void,
    title: string,
    icon?: React.ReactNode,
  ) => (
    <Button
      variant="outline"
      size="xs"
      className="text-foreground/80"
      onClick={onClick}
      disabled={props.busy || props.disabled}
      title={title}
    >
      {icon}
      {label}
    </Button>
  );
  const reviseAction = (label: string, title: string) =>
    !props.instructionOpen &&
    action(label, props.onInstruct, title, <SparklesIcon className="text-muted-foreground" />);

  if (props.draft) {
    const context = [
      props.draft.playbook_name ? `Playbook: ${props.draft.playbook_name}` : null,
      props.draft.agent_notes,
    ]
      .filter(Boolean)
      .join("\n\n");
    return (
      <span className="flex min-w-0 max-w-full flex-wrap items-center gap-x-2.5 gap-y-1">
        <span role="status" className="flex min-w-0 items-center gap-1.5" title={context || undefined}>
          <SparklesIcon className="h-3 w-3 shrink-0 text-foreground/70" />
          <span className="shrink-0 font-medium text-foreground/80">
            {props.usingDraft ? "AI draft" : "New AI draft"}
          </span>
          {props.usingDraft && props.draft.playbook_name && (
            <span className="min-w-0 truncate">· {props.draft.playbook_name}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1">
          {props.canUndo && action("Undo", props.onUndo, "Restore the reply from before this rewrite")}
          {!props.usingDraft && action("Replace", props.onUse, "Replace reply with AI draft")}
          {reviseAction("Revise", "Tell AI how to change this reply")}
          {action(props.busy ? "Discarding…" : "Discard", props.onDiscard, "Discard AI draft and clear reply")}
        </span>
      </span>
    );
  }

  if (props.status === "processing") {
    return (
      <span role="status" className="flex shrink-0 items-center gap-1.5 px-1.5">
        <SparklesIcon className="h-3 w-3 animate-pulse" />
        Drafting…
      </span>
    );
  }

  if (!props.canDraft) return null;

  return (
    <span className="flex shrink-0 items-center gap-2.5">
      {props.status === "failed" && (
        <span title={props.error ?? undefined}>Automatic draft failed</span>
      )}
      {reviseAction("Draft with AI", "Ask AI to draft a reply, optionally with an instruction")}
    </span>
  );
}

function InstructionBar(props: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (value: string) => void;
  hasReply: boolean;
  pending: boolean;
  disabled: boolean;
  error: string | null;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const verb = props.hasReply ? "Rewrite" : "Draft";
  return (
    <div className="border-b border-border/70 bg-muted/35">
      <form
        className="flex min-h-10 items-center gap-2 py-1 pr-1.5 pl-3.5"
        onSubmit={(event) => {
          event.preventDefault();
          props.onSubmit();
        }}
      >
        <SparklesIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input
          ref={props.inputRef}
          value={props.value}
          onChange={(event) => props.onChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter that confirms an IME composition must not submit.
            if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
              event.preventDefault();
            } else if (event.key === "Escape") {
              event.preventDefault();
              props.onClose();
            }
          }}
          disabled={props.pending || props.disabled}
          maxLength={2000}
          aria-label="Instruction for the AI draft"
          aria-invalid={props.error ? true : undefined}
          placeholder={
            props.hasReply
              ? "How should AI change this reply? e.g. shorter, firmer on the refund"
              : "Optional: tell AI what to write, e.g. decline politely"
          }
          className="h-8 min-w-0 flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60"
        />
        <Button
          type="submit"
          variant="outline"
          size="xs"
          className="shrink-0"
          disabled={props.pending || props.disabled}
        >
          {props.pending && <SparklesIcon className="animate-pulse" />}
          {props.pending ? `${verb === "Rewrite" ? "Rewriting" : "Drafting"}…` : verb}
          {!props.pending && (
            <span className="hidden sm:contents">
              <Kbd>↵</Kbd>
            </span>
          )}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          aria-label="Close AI instruction"
          title="Close (Esc)"
          disabled={props.pending}
          onClick={props.onClose}
        >
          <XIcon />
        </Button>
      </form>
      {props.error && (
        <p role="alert" className="px-3.5 pb-2 text-xs leading-5 text-destructive">
          {props.error} Your reply is unchanged.
        </p>
      )}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.max(0.1, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

function Kbd(props: { children: React.ReactNode }) {
  return (
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded border bg-muted/50 px-1 font-sans text-[11px] font-medium text-muted-foreground">
      {props.children}
    </kbd>
  );
}

function AuthorBadge(props: { tone: "agent" | "human"; children: React.ReactNode }) {
  return (
    <Badge
      variant={props.tone === "agent" ? "outline" : "secondary"}
      className="h-5 rounded-md px-1.5 text-[11px] font-medium"
    >
      {props.children}
    </Badge>
  );
}

function ThreadViewSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <div className="flex h-full flex-col bg-canvas" aria-busy="true" aria-label="Loading conversation">
      <div className="flex h-16 items-center gap-3 border-b bg-background px-4 md:px-6">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          className="-ml-1 md:hidden"
          aria-label="Back to conversations"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Button>
        <div className="space-y-2">
          <div className="h-3.5 w-56 animate-pulse rounded bg-muted" />
          <div className="h-2.5 w-32 animate-pulse rounded bg-muted/70" />
        </div>
      </div>
      <div className="mr-auto w-full max-w-[800px] space-y-3 px-4 py-5 sm:px-6 md:py-6">
        {[0, 1].map((item) => (
          <Card key={item} className="animate-pulse p-5">
            <div className="flex items-center gap-3">
              <span className="h-9 w-9 rounded-full bg-muted" />
              <span className="h-3 w-36 rounded bg-muted" />
            </div>
            <div className="mt-5 space-y-2">
              <span className="block h-3 w-full rounded bg-muted" />
              <span className="block h-3 w-4/5 rounded bg-muted" />
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
