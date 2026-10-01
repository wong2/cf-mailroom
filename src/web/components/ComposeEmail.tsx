import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { composeEmail, ComposeRequestError, fetchDomains, fetchMailboxes } from "../api";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES, MAX_MESSAGE_CHARS, MAX_SUBJECT_CHARS } from "../../shared/email-limits";
import { PaperclipIcon, SendIcon, XIcon } from "./Icons";

const ComposeContext = createContext<(mailboxId: number | null) => void>(() => {});
export const useCompose = () => useContext(ComposeContext);

/** Extends the inbox's existing Geist/neutral controls with a focused letter editor.
 * Address rows lead into an unboxed writing area; send/attachments stay in the
 * footer. Closing preserves the draft for this page session, including files.
 */
export function ComposeEmailProvider({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [preferredMailbox, setPreferredMailbox] = useState<number | null>(null);
  const [mailboxId, setMailboxId] = useState("");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const attempt = useRef<Parameters<typeof composeEmail>[0] | null>(null);
  const inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const toRef = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mailboxes = useQuery({ queryKey: ["mailboxes"], queryFn: fetchMailboxes, enabled: open });
  const domains = useQuery({ queryKey: ["domains"], queryFn: fetchDomains, enabled: open });
  const hasDraft = Boolean(to || subject || text || files.length);
  const locked = sending || uncertain;
  const activeDomains = new Set(domains.data?.filter((domain) => domain.status === "active").map((domain) => domain.name.toLowerCase()));
  const available = (mailboxes.data ?? []).filter((mailbox) => activeDomains.has(mailbox.address.split("@")[1]?.toLowerCase()));
  const ready = available.some((mailbox) => String(mailbox.id) === mailboxId);
  const loading = mailboxes.isLoading || domains.isLoading;
  const loadError = mailboxes.isError || domains.isError;

  useEffect(() => {
    if (!open || hasDraft || locked) return;
    const preferred = available.find((mailbox) => mailbox.id === preferredMailbox) ?? available[0];
    setMailboxId(preferred ? String(preferred.id) : "");
    // Only choose the initial sender when opening or receiving inbox data.
    // A user's selection while the editor is open must not reset itself.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, preferredMailbox, mailboxes.data, domains.data]);

  useEffect(() => {
    if (!hasDraft) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [hasDraft]);

  const reset = () => {
    setTo(""); setSubject(""); setText(""); setFiles([]);
    setNotice(null); setFileError(null); setFailed(false); setUncertain(false);
    setConfirmDiscard(false); attempt.current = null;
  };

  const send = async () => {
    if (inFlight.current || confirmDiscard || (!uncertain && (!ready || !formRef.current?.reportValidity()))) return;
    if (!uncertain && !text.trim() && files.length === 0) {
      setNotice("Write a message or attach a file before sending.");
      return;
    }
    if (!attempt.current) {
      attempt.current = { mailboxId: Number(mailboxId), to: to.trim(), subject: subject.trim(), text: text.trim(), files: [...files], attemptId: crypto.randomUUID() };
    }
    inFlight.current = true;
    setSending(true); setNotice(null); setFailed(false);
    try {
      const result = await composeEmail(attempt.current);
      if (result.status === "sent" && result.conversation_id !== null) {
        const sender = attempt.current.mailboxId;
        reset(); setOpen(false);
        void queryClient.invalidateQueries({ queryKey: ["threads"] });
        void queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
        navigate(`/mailboxes/${sender}/threads/${result.conversation_id}`);
      } else if (result.status === "failed") {
        setUncertain(false); setFailed(true); attempt.current = null;
        setNotice(result.error ?? "The email provider rejected this message. You can edit it and try again.");
      } else {
        setUncertain(true);
        setNotice("Send confirmation is pending. Check again before starting another message; this will not send a duplicate.");
      }
    } catch (error) {
      if (!uncertain && error instanceof ComposeRequestError && error.status >= 400 && error.status < 500) {
        setUncertain(false); attempt.current = null;
        setNotice(error.message);
      } else {
        setUncertain(true);
        setNotice("The connection was interrupted, so we couldn’t confirm delivery. Check the same send again to avoid duplicates.");
      }
    } finally {
      inFlight.current = false; setSending(false);
    }
  };

  const addFiles = (selected: FileList | null) => {
    if (!selected) return;
    const next = [...files, ...selected];
    if (next.length > MAX_ATTACHMENTS_PER_MESSAGE) setFileError("Attach up to 10 files per message.");
    else if (next.some((file) => file.size === 0)) setFileError("Empty files cannot be attached.");
    else if (next.reduce((size, file) => size + file.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) setFileError("Attachments must total 3 MB or less.");
    else { setFiles(next); setFileError(null); }
    if (fileInput.current) fileInput.current.value = "";
  };

  const close = () => { if (!inFlight.current) { setOpen(false); setConfirmDiscard(false); } };
  const setup = () => { close(); navigate("/settings/inboxes"); };

  return (
    <ComposeContext.Provider value={(id) => { setPreferredMailbox(id); setOpen(true); }}>
      {children}
      <Dialog open={open} onOpenChange={(value) => { if (!value) close(); }}>
        <DialogContent
          showCloseButton={false}
          className="flex max-h-[calc(100dvh_-_2rem)] max-w-[calc(100vw_-_2rem)] flex-col gap-0 overflow-hidden p-0 sm:max-w-2xl"
          onOpenAutoFocus={(event) => {
            if (toRef.current && !toRef.current.matches(":disabled")) { event.preventDefault(); toRef.current.focus(); }
          }}
          onPointerDownOutside={(event) => event.preventDefault()}
        >
          <header className="flex shrink-0 items-center justify-between border-b px-5 py-4">
            <DialogTitle>New message</DialogTitle>
            <DialogDescription className="sr-only">Write a new email. Closing keeps your draft until you leave or reload this page.</DialogDescription>
            <Button type="button" variant="ghost" size="icon" onClick={close} disabled={sending} aria-label="Close and keep draft" title="Close and keep draft">
              <XIcon className="h-4 w-4" />
            </Button>
          </header>
          <form ref={formRef} className="flex min-h-0 flex-1 flex-col" onSubmit={(event) => { event.preventDefault(); void send(); }} onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void send(); }
          }}>
            <div className="min-h-0 flex-1 overflow-y-auto px-5">
              {loading ? <p className="py-4 text-sm text-muted-foreground" role="status">Loading your inboxes…</p> : loadError ? (
                <div className="py-4 text-sm" role="alert">Couldn’t load your sending inboxes. <Button type="button" variant="link" onClick={() => { void mailboxes.refetch(); void domains.refetch(); }}>Try again</Button></div>
              ) : available.length === 0 ? (
                <div className="py-4 text-sm"><p>Set up an inbox and activate its domain before sending.</p><Button type="button" variant="link" className="px-0" onClick={setup}>Set up an inbox</Button></div>
              ) : null}
              <fieldset disabled={locked || loading || loadError || available.length === 0} className="min-w-0 disabled:opacity-60">
                <div className="flex min-h-12 items-center gap-3 border-b">
                  <label htmlFor="compose-from" className="w-14 shrink-0 text-sm text-muted-foreground">From</label>
                  <select id="compose-from" value={mailboxId} onChange={(event) => setMailboxId(event.target.value)} required className="min-w-0 flex-1 rounded-md bg-transparent py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <option value="" disabled>Choose an inbox</option>
                    {available.map((mailbox) => <option key={mailbox.id} value={mailbox.id}>{mailbox.address}</option>)}
                  </select>
                </div>
                <div className="flex min-h-12 items-center gap-3 border-b">
                  <label htmlFor="compose-to" className="w-14 shrink-0 text-sm text-muted-foreground">To</label>
                  <Input ref={toRef} id="compose-to" type="email" autoComplete="off" required maxLength={254} placeholder="recipient@example.com" value={to} onChange={(event) => setTo(event.target.value)} className="min-w-0 border-0 shadow-none" />
                </div>
                <div className="flex min-h-12 items-center gap-3 border-b">
                  <label htmlFor="compose-subject" className="w-14 shrink-0 text-sm text-muted-foreground">Subject</label>
                  <Input id="compose-subject" required maxLength={MAX_SUBJECT_CHARS} placeholder="Add a subject" value={subject} onChange={(event) => setSubject(event.target.value)} className="min-w-0 border-0 shadow-none" />
                </div>
                <label htmlFor="compose-body" className="sr-only">Message</label>
                <textarea id="compose-body" value={text} onChange={(event) => setText(event.target.value)} onPaste={(event) => {
                  if (event.currentTarget.matches(":disabled") || event.clipboardData.files.length === 0) return;
                  event.preventDefault();
                  addFiles(event.clipboardData.files);
                }} maxLength={MAX_MESSAGE_CHARS} placeholder="Write your message…" className="mt-3 min-h-44 w-full resize-y rounded-md bg-transparent px-2 py-2 text-sm leading-6 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring sm:min-h-64" />
              </fieldset>
              {files.length > 0 && <ul aria-label="Attachments" className="mb-4 space-y-1.5">{files.map((file, index) => (
                <li key={`${file.name}-${index}`} className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-1.5 text-xs">
                  <PaperclipIcon className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 flex-1 truncate" title={file.name}>{file.name}</span>
                  <span className="shrink-0 text-muted-foreground">{Math.max(1, Math.ceil(file.size / 1024))} KB</span>
                  <Button type="button" variant="ghost" size="icon-sm" disabled={locked} aria-label={`Remove ${file.name}`} onClick={() => { setFiles(files.filter((_, i) => i !== index)); setFileError(null); }}><XIcon className="h-3.5 w-3.5" /></Button>
                </li>
              ))}</ul>}
              {fileError && <p role="alert" className="mb-3 text-sm text-destructive">{fileError}</p>}
              {notice && <p role="alert" className={`mb-4 text-sm leading-5 ${uncertain ? "text-muted-foreground" : "text-destructive"}`}>{notice}</p>}
            </div>
            <footer className="shrink-0 border-t bg-muted/30 px-5 py-4">
              {confirmDiscard ? (
                <div role="alert" className="flex flex-wrap items-center gap-2"><p className="mr-auto text-sm">Discard this unsent message?</p><Button type="button" variant="outline" onClick={() => setConfirmDiscard(false)}>Keep writing</Button><Button type="button" variant="destructive" onClick={() => { reset(); setOpen(false); }}>Discard message</Button></div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button type="submit" disabled={sending || (!uncertain && (!ready || loading || loadError))}><SendIcon className="h-4 w-4" />{sending ? (uncertain ? "Checking…" : "Sending…") : uncertain ? "Check send status" : failed ? "Send again" : "Send"}</Button>
                  <input ref={fileInput} type="file" multiple className="hidden" onChange={(event) => addFiles(event.target.files)} tabIndex={-1} />
                  <Button type="button" variant="ghost" size="icon" disabled={locked} aria-label="Attach files" title="Attach files (up to 10 files, 3 MB total)" onClick={() => fileInput.current?.click()}><PaperclipIcon className="h-4 w-4" /></Button>
                  <span className="hidden text-xs text-muted-foreground sm:inline">3 MB attachment limit</span>
                  <Button type="button" variant="ghost" disabled={locked} className="ml-auto text-muted-foreground" onClick={() => hasDraft ? setConfirmDiscard(true) : (reset(), setOpen(false))}>Discard</Button>
                </div>
              )}
            </footer>
          </form>
        </DialogContent>
      </Dialog>
    </ComposeContext.Provider>
  );
}
