import { askModelLabel } from '@aplos/contract/legacy/ask';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Bold,
  Check,
  ChevronDown,
  ChevronsUpDown,
  Italic,
  Link,
  List,
  ListOrdered,
  Paperclip,
  Reply,
  ReplyAll,
  Send,
  SpellCheck,
  Strikethrough,
  TextQuote,
  Trash2,
  Underline,
  X,
  ImageIcon,
} from './icons';
import {
  Avatar,
  Button,
  Checkbox,
  IconButton,
  Kbd,
  Menu,
  Notice,
  Select,
  Spinner,
  Tooltip,
  chooseAction,
  confirmAction,
  cx,
  dialogOpen,
  reducedMotion,
  useMenu,
} from './ui';
import DOMPurify from 'dompurify';
import type { Account, Draft, SendAs, Settings, Thread } from '@aplos/contract/legacy/types';
import {
  bridge,
  escapeHtml,
  fileToAttachment,
  invoke,
  plain,
  replyRecipients,
  uid,
} from './bridge';
import { useVoice } from './useVoice';
import { LevelMeter } from './LevelMeter';
interface Props {
  draft: Draft;
  accounts: Account[];
  settings: Settings;
  thread?: Thread;
  close: () => void;
  notify: (text: string) => void;
  popout?: boolean;
  inline?: boolean;
  fresh?: boolean;
  closing?: boolean;
  holdToTalk?: () => boolean;
  onChange?: (draft: Draft) => void;
  contacts?: Contact[];
  /** An AI-suggested instruction for this reply ("Say which layout direction you prefer"), offered as a one-click draft. */
  suggestion?: string;
  /** Filled with this composer's way out, so the app can close it before going somewhere else. */
  exitRef?: React.MutableRefObject<(() => Promise<boolean>) | null>;
}
const holdDelay = 250;
function splitAddresses(value: string) {
  return value
    .split(/[,;]/)
    .map(item => item.trim())
    .filter(Boolean);
}
export type Contact = { email: string; name: string };
/** The bare address inside "Name <address>" or the value itself. */
export function addressOf(value: string) {
  return (/<([^>]+)>/.exec(value)?.[1] ?? value).trim();
}
export function validAddress(value: string) {
  return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]{2,}$/.test(addressOf(value));
}
function RecipientInput({
  id,
  value,
  onChange,
  disabled,
  names,
  contacts,
  autoFocus,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  names: Map<string, string>;
  contacts: Contact[];
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [pick, setPick] = useState(0);
  const [focused, setFocused] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = splitAddresses(value);
  const chosen = new Set(list.map(address => addressOf(address).toLowerCase()));
  const query = text.trim().toLowerCase();
  const suggestions = query
    ? contacts
        .filter(
          c =>
            !chosen.has(c.email.toLowerCase()) &&
            (c.email.toLowerCase().includes(query) ||
              c.name
                .toLowerCase()
                .split(/\s+/)
                .some(word => word.startsWith(query)) ||
              c.name.toLowerCase().startsWith(query)),
        )
        .slice(0, 6)
    : [];
  const open = focused && suggestions.length > 0;
  function commit(raw = text) {
    const extra = splitAddresses(raw);
    setText('');
    setPick(0);
    if (extra.length) onChange([...list, ...extra].join(', '));
  }
  function choose(contact: Contact) {
    commit(
      contact.name && contact.name !== contact.email
        ? `${contact.name.replace(/[",<>]/g, '')} <${contact.email}>`
        : contact.email,
    );
    input.current?.focus();
  }
  function label(address: string) {
    const named = /^\s*"?([^"<]+?)"?\s*<([^>]+)>/.exec(address);
    if (named) return named[1];
    return names.get(address.toLowerCase()) || address;
  }
  return (
    <div
      className="recipient-input"
      onMouseDown={e => {
        if (e.target === e.currentTarget) {
          e.preventDefault();
          input.current?.focus();
        }
      }}
    >
      {list.map((address, index) => {
        const invalid = !validAddress(address);
        return (
          <Tooltip
            key={address + index}
            content={invalid ? 'This doesn’t look like an email address' : addressOf(address)}
            disabled={!invalid && label(address) === address}
          >
            <span className={cx('recipient-chip', invalid && 'is-invalid')}>
              <span>{label(address)}</span>
              <button
                type="button"
                aria-label={'Remove ' + address}
                disabled={disabled}
                onClick={() => onChange(list.filter((_, i) => i !== index).join(', '))}
              >
                <X size={10} />
              </button>
            </span>
          </Tooltip>
        );
      })}
      <input
        id={id}
        ref={input}
        value={text}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={list.length ? '' : placeholder}
        autoComplete="off"
        spellCheck={false}
        role="combobox"
        aria-expanded={open}
        aria-controls={id + '-suggestions'}
        aria-autocomplete="list"
        aria-activedescendant={open ? `${id}-option-${pick}` : undefined}
        onChange={e => {
          const next = e.target.value;
          setPick(0);
          if (/[,;]$/.test(next)) commit(next.slice(0, -1));
          else setText(next);
        }}
        onFocus={() => setFocused(true)}
        onKeyDown={e => {
          if (open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault();
            setPick(
              i => (i + (e.key === 'ArrowDown' ? 1 : -1) + suggestions.length) % suggestions.length,
            );
            return;
          }
          if (open && e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            setFocused(false);
            return;
          }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            commit();
            return;
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && text.trim()) {
            e.preventDefault();
            if (open) choose(suggestions[Math.min(pick, suggestions.length - 1)]);
            else commit();
          } else if (e.key === 'Backspace' && !text && list.length)
            onChange(list.slice(0, -1).join(', '));
        }}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
      />
      {open && (
        <div
          className="recipient-suggestions ui-surface"
          id={id + '-suggestions'}
          role="listbox"
          aria-label="Suggested recipients"
        >
          {suggestions.map((contact, index) => (
            <div
              key={contact.email}
              id={`${id}-option-${index}`}
              role="option"
              aria-selected={index === pick}
              className={cx('recipient-suggestion ui-surface-item', index === pick && 'is-active')}
              onMouseDown={e => {
                e.preventDefault();
                choose(contact);
              }}
              onMouseMove={() => setPick(index)}
            >
              <Avatar name={contact.name || contact.email} size={22} />
              <span>
                <strong>{contact.name || contact.email}</strong>
                {contact.name && <small>{contact.email}</small>}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
/** Dictation goes above a quoted message at the end of the body (a forward's original), or at the very end. */
function withDictation(previous: string, html: string) {
  const doc = new DOMParser().parseFromString(previous, 'text/html');
  const quote = doc.body.lastElementChild;
  if (quote?.tagName !== 'BLOCKQUOTE') return previous + html;
  // Keep the blank line a forward leaves above the quote between the new text and the quote.
  const blank = quote.previousElementSibling;
  const at = blank && !blank.textContent?.trim() && !blank.querySelector('img') ? blank : quote;
  at.insertAdjacentHTML('beforebegin', html);
  return doc.body.innerHTML;
}
function keepImages(previous: string, next: string) {
  const oldDocument = new DOMParser().parseFromString(previous, 'text/html');
  const nextDocument = new DOMParser().parseFromString(DOMPurify.sanitize(next), 'text/html');
  const sources = new Set(Array.from(nextDocument.images).map(image => image.getAttribute('src')));
  for (const image of Array.from(oldDocument.images)) {
    const source = image.getAttribute('src');
    if (source && !sources.has(source)) {
      const paragraph = nextDocument.createElement('p');
      paragraph.append(nextDocument.importNode(image, true));
      nextDocument.body.append(paragraph);
      sources.add(source);
    }
  }
  return DOMPurify.sanitize(nextDocument.body.innerHTML);
}
/** The red edge while dictating; it brightens with the voice, written straight to the element so React doesn't render every frame. */
function VoiceGlow({ active, level }: { active: boolean; level: () => number }) {
  const glow = useRef<HTMLSpanElement>(null);
  const read = useRef(level);
  read.current = level;
  useEffect(() => {
    let frame = 0;
    let shown = Number(glow.current?.style.opacity || 0);
    const still = reducedMotion();
    const draw = () => {
      const target = active ? (still ? 0.8 : 0.45 + read.current() * 0.55) : 0;
      shown += (target - shown) * (active ? 0.2 : 0.14);
      if (glow.current)
        glow.current.style.opacity = shown < 0.01 && !active ? '0' : shown.toFixed(3);
      if (active || shown >= 0.01) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return <span ref={glow} className="compose-glow" aria-hidden="true" />;
}
export function Compose({
  draft,
  accounts,
  settings,
  thread,
  close,
  notify,
  popout,
  inline,
  fresh,
  closing,
  holdToTalk,
  onChange,
  contacts = [],
  suggestion,
  exitRef,
}: Props) {
  const [form, setForm] = useState<Draft>(draft);
  const current = useRef(form);
  const editor = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const [expanded, setExpanded] = useState(!!(draft.cc || draft.bcc));
  const [saved, setSaved] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(draft.sendError || '');
  const [suggested, setSuggested] = useState(suggestion);
  const mounted = useRef(true);
  const dirty = useRef(false);
  const edits = useRef(0);
  const saving = useRef<Promise<Draft>>(Promise.resolve(draft));
  const operation = useRef('');
  const workVersion = useRef(0);
  const aiRequest = useRef<string | undefined>(undefined);
  const terminal = useRef(false);
  const lastProp = useRef(draft);
  const terminalJob = useRef<Promise<void> | undefined>(undefined);
  const resend = useRef(false);
  const signatureOn =
    form.signature &&
    settings.signatureMode !== 'never' &&
    (settings.signatureMode === 'always' || ['new', 'forward'].includes(form.mode));
  const sendingAccount = accounts.find(account => account.id === form.accountId);
  const fromEmail = form.fromEmail || sendingAccount?.email || '';
  const sendingAlias = sendingAccount?.sendAs?.find(
    alias => alias.email.toLowerCase() === fromEmail.toLowerCase(),
  );
  const senderName = sendingAlias?.name || sendingAccount?.name || '';
  const signatureSource = form.signatureSource ?? 'custom';
  const accountSignature = signatureSource === 'account' ? sendingAlias?.signature || '' : '';
  const lockAccount = form.mode !== 'new' || !!form.threadId;
  function senders(account: Account) {
    const aliases = account.sendAs ?? [];
    return aliases.some(alias => alias.email.toLowerCase() === account.email.toLowerCase())
      ? aliases
      : [
          {
            email: account.email,
            name: account.name,
            signature: '',
            isDefault: !aliases.some(alias => alias.isDefault),
          },
          ...aliases,
        ];
  }
  const senderAvailable = Boolean(
    sendingAccount &&
    senders(sendingAccount).some(alias => alias.email.toLowerCase() === fromEmail.toLowerCase()),
  );
  function changeSender(account: Account, alias: SendAs) {
    if (!account.connected || (lockAccount && account.id !== form.accountId)) return;
    patch({
      accountId: account.id,
      fromEmail: alias.email,
      signatureSource:
        account.capabilities?.signatures !== false && account.provider !== 'demo'
          ? signatureSource
          : 'custom',
    });
  }

  function update(next: Draft) {
    current.current = next;
    if (mounted.current) {
      setForm(next);
      onChange?.(next);
    }
  }
  function patch(value: Partial<Draft>, internal = false) {
    if (terminal.current || (!internal && operation.current)) return;
    dirty.current = true;
    edits.current++;
    setSaved(false);
    setError('');
    update({ ...current.current, ...value, updatedAt: new Date().toISOString() });
  }
  function working(name: string) {
    operation.current = name;
    if (mounted.current) setBusy(name);
  }
  function stopWork() {
    workVersion.current++;
    voice.cancel();
    if (aiRequest.current)
      void invoke('ai.cancel', { requestId: aiRequest.current }).catch(() => {});
    aiRequest.current = undefined;
  }
  useEffect(() => {
    if (editor.current) editor.current.innerHTML = DOMPurify.sanitize(draft.html);
  }, [draft.id]);
  useEffect(() => {
    if (lastProp.current === draft) return;
    lastProp.current = draft;
    if (terminal.current) return;
    stopWork();
    working('');
    const next = {
      ...current.current,
      ...draft,
      html: keepImages(current.current.html, draft.html),
      revision: Math.max(current.current.revision, draft.revision),
    };
    if (editor.current) editor.current.innerHTML = next.html;
    patch(next, true);
    setExpanded(Boolean(next.cc || next.bcc));
  }, [draft]);
  async function save(): Promise<Draft> {
    const job = saving.current
      .catch(() => current.current)
      .then(async () => {
        if (!dirty.current) return current.current;
        const version = edits.current;
        const snapshot = {
          ...current.current,
          html: editor.current?.innerHTML ?? current.current.html,
        };
        const result = await invoke<Draft>('draft.save', { draft: snapshot });
        update({ ...current.current, revision: result.revision });
        if (edits.current === version) {
          dirty.current = false;
          if (mounted.current) setSaved(true);
        }
        return result;
      });
    saving.current = job;
    return job;
  }
  useEffect(() => {
    if (!dirty.current || terminal.current) return;
    const timer = setTimeout(() => {
      if (!terminal.current)
        void save().catch(error => {
          if (mounted.current) setError(error.message);
        });
    }, 650);
    return () => clearTimeout(timer);
  }, [form]);
  /** Catches the usual mistakes before a message leaves; resolves false when the person wants to fix something. */
  async function readyToSend() {
    const d = current.current;
    const invalid = [d.to, d.cc, d.bcc]
      .flatMap(splitAddresses)
      .find(address => !validAddress(address));
    if (invalid) {
      setError(`“${invalid}” doesn’t look like an email address.`);
      return false;
    }
    if (!d.to.trim() && !d.cc.trim() && !d.bcc.trim()) {
      setError('Add at least one recipient.');
      document.getElementById('compose-to')?.focus();
      return false;
    }
    if (
      !d.subject.trim() &&
      !(await confirmAction({
        title: 'Send without a subject?',
        message: 'A subject helps people find this message later.',
        confirmLabel: 'Send anyway',
      }))
    ) {
      document.getElementById('compose-subject')?.focus();
      return false;
    }
    const written = editor.current?.cloneNode(true) as HTMLElement | undefined;
    written?.querySelectorAll('blockquote').forEach(quote => quote.remove());
    if (
      !d.attachments.length &&
      /\b(attached|attachment|attachments|enclosed)\b/i.test(written?.textContent ?? '') &&
      !(await confirmAction({
        title: 'Send without an attachment?',
        message: 'Your message mentions an attachment, but nothing is attached.',
        confirmLabel: 'Send anyway',
      }))
    )
      return false;
    return true;
  }
  const checking = useRef(false);
  async function finish(kind: 'close' | 'send' | 'popout' | 'discard' | 'native-close') {
    if (terminal.current) {
      if (kind === 'native-close') {
        await terminalJob.current;
        await invoke(terminal.current ? 'window.closeReady' : 'window.closeCancel');
      }
      return;
    }
    if (kind === 'send' && (operation.current || voice.isActive())) {
      setError('Finish the current recording or operation before sending.');
      return;
    }
    if (kind === 'send') {
      if (checking.current) return;
      checking.current = true;
      try {
        if (!(await readyToSend())) return;
      } finally {
        checking.current = false;
      }
      if (terminal.current) return;
    }
    terminal.current = true;
    stopWork();
    working(kind);
    setError('');
    const job = (async () => {
      try {
        if (kind === 'close' && fresh && blank()) {
          // A draft that was opened and closed without anything written is not worth keeping.
          await saving.current.catch(() => {});
          await invoke('draft.delete', { id: current.current.id });
          dirty.current = false;
          close();
        } else if (kind === 'discard') {
          await saving.current.catch(() => {});
          await invoke('draft.delete', { id: current.current.id });
          dirty.current = false;
          close();
          notify('Draft discarded');
        } else {
          if (kind === 'send' && !current.current.to.trim())
            throw new Error('Add at least one recipient.');
          await save();
          if (kind === 'send') {
            await invoke('draft.send', {
              id: current.current.id,
              ...(resend.current ? { resend: true } : {}),
            });
            resend.current = false;
            notify(
              settings.undoSeconds
                ? `Sending in ${settings.undoSeconds} seconds. You can undo from the inbox.`
                : 'Message queued',
            );
            close();
          } else if (kind === 'popout') {
            await invoke('window.compose', { draftId: current.current.id });
            close();
          } else if (kind === 'native-close') await invoke('window.closeReady');
          else close();
        }
      } catch (error) {
        terminal.current = false;
        working('');
        if (mounted.current) setError((error as Error).message);
        if (kind === 'native-close') await invoke('window.closeCancel').catch(() => {});
      }
    })();
    terminalJob.current = job;
    await job;
  }
  /**
   * Every way out of the composer (Esc, the backdrop, going elsewhere in the app) comes here. A new draft with something
   * in it asks whether to keep it or delete it; resolves false when the person keeps editing.
   */
  const leaving = useRef<Promise<boolean> | null>(null);
  function leave() {
    leaving.current ??= (async () => {
      try {
        if (terminal.current) {
          await terminalJob.current;
          return terminal.current;
        }
        // Finish a recording or transcription first, so what was said lands in the draft before deciding about it.
        if (voice.isActive()) {
          const state = hold.current;
          if (state) {
            clearTimeout(state.timer);
            state.cancelled = true;
          }
          voice.stop();
          for (
            const until = Date.now() + 20000;
            voice.isActive() && mounted.current && Date.now() < until;
          )
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        // Only a draft started in this session asks; one reopened from Drafts is already saved there, edits included.
        if (fresh && !blank()) {
          const choice = await chooseAction({
            title: 'Save this draft?',
            message: 'Keep it in Drafts to finish later, or delete it.',
            confirmLabel: 'Save draft',
            cancelLabel: 'Keep editing',
            alternateLabel: 'Delete',
          });
          if (!choice) return false;
          if (choice === 'alternate') {
            await finish('discard');
            return terminal.current;
          }
        }
        await finish('close');
        return terminal.current;
      } finally {
        leaving.current = null;
      }
    })();
    return leaving.current;
  }
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => {
    if (!exitRef) return;
    const exit = () => leaveRef.current();
    exitRef.current = exit;
    return () => {
      if (exitRef.current === exit) exitRef.current = null;
    };
  }, [exitRef]);
  const closeHandler = useRef(() => finish('native-close'));
  closeHandler.current = () => finish('native-close');
  // A renderer-initiated window.close() can reach beforeunload without the native close event.
  // Hold that path too, then ask main to close this window only after the draft has reached storage.
  useEffect(() => {
    const unload = (event: BeforeUnloadEvent) => {
      if (!dirty.current || terminal.current) return;
      event.preventDefault();
      event.returnValue = '';
      if (window.aplos) void closeHandler.current();
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, []);
  useEffect(
    () =>
      bridge.subscribe(event => {
        if (event.type === 'prepare-close') void closeHandler.current();
      }),
    [],
  );
  useEffect(() => {
    mounted.current = true;
    terminal.current = false;
    return () => {
      mounted.current = false;
      terminal.current = true;
      stopWork();
    };
  }, []);
  useEffect(() => {
    function keyboard(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        dialogOpen() ||
        (event.target as HTMLElement)?.closest?.('.ask-panel')
      )
        return;
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void finish('send');
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        void leave();
      }
    }
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });
  function setBody(html: string, preserveImages = false) {
    const safe = preserveImages ? keepImages(current.current.html, html) : DOMPurify.sanitize(html);
    if (editor.current) editor.current.innerHTML = safe;
    patch({ html: safe }, true);
  }
  // Tab and the chip act only while the chip is on screen, and the suggestion is kept if the draft could not start.
  function suggestionShown() {
    return !!suggested && !busy && !listening && bodyEmpty(form.html);
  }
  function takeSuggestion() {
    if (!suggested || operation.current || terminal.current || voice.isActive()) return;
    const instruction = suggested;
    setSuggested(undefined);
    void ai('draft', instruction, true);
  }
  function applyProposal(proposal: Partial<Draft>) {
    const fields: Partial<Draft> = {};
    for (const key of ['to', 'cc', 'bcc', 'subject'] as const)
      if (typeof proposal[key] === 'string' && proposal[key]!.trim()) fields[key] = proposal[key];
    if (proposal.html !== undefined) setBody(proposal.html, true);
    patch(fields, true);
    if (fields.cc || fields.bcc) setExpanded(true);
  }
  // `bodyOnly`: the instruction came from the email itself (a suggestion), so it may write the reply but never change who it goes to.
  async function ai(kind: 'polish' | 'draft', instruction: string, bodyOnly = false) {
    if (operation.current || terminal.current || voice.isActive()) return;
    const version = ++workVersion.current;
    const requestId = uid();
    aiRequest.current = requestId;
    setError('');
    working(kind);
    try {
      const snapshot = {
        ...current.current,
        html: editor.current?.innerHTML ?? current.current.html,
      };
      if (kind === 'polish') {
        const result = await invoke<{ html: string }>('ai.polish', {
          html: snapshot.html,
          instruction,
          requestId,
        });
        if (workVersion.current !== version || terminal.current) return;
        setBody(result.html, true);
      } else {
        const result = await invoke<Partial<Draft>>('ai.draft', {
          instruction,
          threadId: thread?.id,
          draft: snapshot,
          requestId,
        });
        if (workVersion.current !== version || terminal.current) return;
        applyProposal(bodyOnly ? { html: result.html } : result);
      }
    } catch (error) {
      if (workVersion.current === version && mounted.current) setError((error as Error).message);
    } finally {
      if (workVersion.current === version) {
        aiRequest.current = undefined;
        working('');
      }
    }
  }
  const voice = useVoice(
    settings.microphone,
    async text => {
      if (terminal.current || !text.trim()) return;
      const version = ++workVersion.current;
      const html = `<p>${escapeHtml(text.trim()).replace(/\n/g, '<br>')}</p>`;
      const previous = editor.current?.innerHTML ?? current.current.html;
      // Persist the transcript immediately so closing during polish cannot discard it.
      setBody(withDictation(previous, html));
      try {
        if (settings.autoPolish) {
          const requestId = uid();
          aiRequest.current = requestId;
          working('polish');
          const result = await invoke<{ html: string }>('ai.polish', {
            html,
            instruction:
              'Proofread this dictated email text. Preserve its meaning and do not add a greeting or signature.',
            requestId,
          });
          if (workVersion.current !== version || terminal.current) return;
          setBody(withDictation(previous, DOMPurify.sanitize(result.html)));
        }
      } catch (error) {
        if (workVersion.current === version && !terminal.current)
          setError(`Dictation was inserted without polish: ${(error as Error).message}`);
      } finally {
        if (workVersion.current === version) {
          aiRequest.current = undefined;
          working('');
        }
      }
    },
    setError,
  );
  /** Pasted or dropped files: images that land in the body go inline, everything else is attached. */
  function receive(files: File[], intoBody: boolean) {
    const images = intoBody ? files.filter(item => item.type.startsWith('image/')) : [];
    const others = files.filter(item => !images.includes(item));
    void (async () => {
      if (images.length) await attach(images, true);
      if (others.length) await attach(others);
    })();
  }
  async function attach(files: FileList | File[] | null, asImage = false) {
    if (!files || operation.current || terminal.current) return;
    const version = ++workVersion.current;
    working('attach');
    try {
      for (const item of Array.from(files)) {
        if (item.size > 20 * 1024 * 1024) throw new Error('Each attachment must be under 20 MB.');
        const attachment = await fileToAttachment(item);
        if (workVersion.current !== version || terminal.current) return;
        if (asImage) {
          if (!attachment.type.startsWith('image/')) throw new Error('Choose an image file.');
          setBody(
            (editor.current?.innerHTML ?? current.current.html) +
              `<p><img src="data:${attachment.type};base64,${attachment.data}" alt="${escapeHtml(attachment.name)}" style="max-width:100%"></p>`,
          );
        } else {
          if (
            current.current.attachments.reduce(
              (total, item) => total + item.size,
              attachment.size,
            ) >
            25 * 1024 * 1024
          )
            throw new Error('Attachments must total less than 25 MB.');
          patch({ attachments: [...current.current.attachments, attachment] }, true);
        }
      }
    } catch (error) {
      if (workVersion.current === version) setError((error as Error).message);
    } finally {
      if (workVersion.current === version) working('');
    }
  }
  function format(command: string, value?: string) {
    if (operation.current || terminal.current) return;
    editor.current?.focus();
    document.execCommand(command, false, value);
    patch({ html: editor.current?.innerHTML ?? '' });
  }
  function quote() {
    const node = getSelection()?.anchorNode;
    const element = node instanceof Element ? node : node?.parentElement;
    const block = element?.closest('blockquote');
    const inside = !!block && !!editor.current?.contains(block);
    const blocks = inside
      ? Array.from(block.children).filter(child => /^(P|DIV|UL|OL|BLOCKQUOTE)$/.test(child.tagName))
      : [];
    // A quoted list (what Quote makes of one) is lifted back out by hand, since formatBlock can't. A quote of
    // paragraphs, such as a forward's original, isn't undone; Quote then quotes the line inside it.
    if (blocks.length && blocks.every(child => /^(UL|OL)$/.test(child.tagName))) {
      if (operation.current || terminal.current) return;
      block!.replaceWith(...Array.from(block!.childNodes));
      patch({ html: editor.current?.innerHTML ?? '' });
    } else format('formatBlock', inside && !blocks.length ? 'p' : 'blockquote');
  }
  function bodyEmpty(html = editor.current?.innerHTML ?? current.current.html) {
    return !plain(html).trim() && !/<img/i.test(html);
  }
  function blank() {
    const d = current.current;
    return (
      bodyEmpty() &&
      !d.attachments.length &&
      (d.mode !== 'new' || (!d.to.trim() && !d.cc.trim() && !d.bcc.trim() && !d.subject.trim()))
    );
  }
  // Holding Space anywhere in the composer (or the talk button under it) dictates; a quick tap still does what Space would.
  type Hold = {
    timer?: ReturnType<typeof setTimeout>;
    recording: boolean;
    source: 'key' | 'pointer';
    target?: HTMLElement;
    cancelled?: boolean;
  };
  const hold = useRef<Hold | null>(null);
  useEffect(() => {
    if (holdToTalk?.()) {
      hold.current = { recording: true, source: 'key' };
      void voice.start();
    } else if (inline || form.to) editor.current?.focus();
  }, []);
  function press(source: Hold['source'], target?: HTMLElement) {
    const state: Hold = { recording: false, source, target };
    state.timer = setTimeout(() => {
      state.recording = true;
      void voice.start();
    }, holdDelay);
    hold.current = state;
  }
  /** The Space held back while deciding between a tap and a hold, typed or pressed the way the keyboard would have. */
  function tapSpace(target?: HTMLElement) {
    if (!target?.isConnected) return;
    if (
      target.isContentEditable ||
      target.matches('textarea,input:not([type=checkbox],[type=radio])')
    ) {
      if (document.activeElement !== target) target.focus();
      document.execCommand('insertText', false, ' ');
    } else if (target.matches('button,[role=button],input[type=checkbox]')) target.click();
  }
  function release(tap: boolean) {
    const state = hold.current;
    if (!state) return;
    hold.current = null;
    clearTimeout(state.timer);
    if (state.cancelled) return;
    if (state.recording) voice.stop();
    else if (tap && state.source === 'pointer') void voice.start();
    else if (tap) tapSpace(state.target);
  }
  /** Esc drops the recording (or its transcription) instead of closing the draft. The held key stays claimed until it comes up. */
  function cancelVoice() {
    const state = hold.current;
    if (state) {
      clearTimeout(state.timer);
      state.cancelled = true;
    }
    voice.cancel();
  }
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const state = hold.current;
      if (
        event.key === 'Escape' &&
        ((state && !state.cancelled) || voice.isActive()) &&
        !dialogOpen()
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancelVoice();
        return;
      }
      if (event.key !== ' ') {
        // Fast typing presses the next key before Space comes up: type the space first so the letters stay in order.
        if (state?.source === 'key' && !state.recording) release(true);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      if (state) {
        event.preventDefault();
        return;
      }
      const target = event.target as HTMLElement;
      if (dialogOpen() || target.tagName === 'SELECT' || target.closest?.('.ask-panel,.ui-popover'))
        return;
      // Outside the composer (an inline reply sits in the reader) Space keeps its usual jobs, scrolling included, once the reply has text.
      if (
        !rootRef.current?.contains(target) &&
        (['INPUT', 'TEXTAREA', 'BUTTON'].includes(target.tagName) ||
          target.isContentEditable ||
          !bodyEmpty())
      )
        return;
      if (event.repeat || operation.current || terminal.current || voice.isActive()) return;
      event.preventDefault();
      press('key', target);
    };
    const up = (event: KeyboardEvent) => {
      if (event.key === ' ' && hold.current?.source === 'key') release(true);
    };
    const pointerUp = () => {
      if (hold.current?.source === 'pointer') release(true);
    };
    const blur = () => release(false);
    const released = () => {
      if (hold.current?.recording) release(false);
    };
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerUp);
    window.addEventListener('blur', blur);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('aplos:talk-release', released);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('aplos:talk-release', released);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerUp);
      window.removeEventListener('blur', blur);
    };
  });
  const names = new Map<string, string>();
  for (const message of thread?.messages ?? [])
    if (message.fromName) names.set(message.from.toLowerCase(), message.fromName);
  const modeMenu = useMenu();
  const fromMenu = useMenu();
  const senderAvatar = (account: Account | undefined, name: string) => (
    <span className="from-avatar" style={{ background: account?.color }}>
      {(name || '?')[0]?.toUpperCase()}
    </span>
  );
  const senderItems = accounts.flatMap(account =>
    senders(account).map(alias => ({
      label: alias.name || account.name,
      hint: alias.email,
      leading: senderAvatar(account, alias.name || account.name || alias.email),
      checked:
        account.id === form.accountId && alias.email.toLowerCase() === fromEmail.toLowerCase(),
      disabled: !account.connected || (lockAccount && account.id !== form.accountId),
      onSelect: () => changeSender(account, alias),
    })),
  );
  if (!senderAvailable)
    senderItems.unshift({
      label: 'Unavailable address',
      hint: fromEmail,
      leading: senderAvatar(sendingAccount, senderName || fromEmail),
      checked: true,
      disabled: true,
      onSelect: () => {},
    });
  function changeMode(mode: 'reply' | 'reply-all') {
    if (!thread || mode === form.mode) return;
    const recipients = replyRecipients(thread, fromEmail, mode);
    patch({ mode, ...recipients });
    setExpanded(!!recipients.cc || !!form.bcc);
  }
  const [link, setLink] = useState('');
  const [showLink, setShowLink] = useState(false);
  // The URL field takes focus, so remember where the caret was in the body.
  const linkRange = useRef<Range | null>(null);
  function toggleLink() {
    const selection = getSelection();
    linkRange.current =
      selection?.rangeCount && editor.current?.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange()
        : null;
    setShowLink(!showLink);
  }
  function insertLink() {
    if (!/^https?:\/\//i.test(link)) {
      setError('Use a full https:// link.');
      return;
    }
    editor.current?.focus();
    const selection = getSelection();
    if (linkRange.current && selection) {
      selection.removeAllRanges();
      selection.addRange(linkRange.current);
    }
    if (selection?.isCollapsed)
      document.execCommand(
        'insertHTML',
        false,
        `<a href="${escapeHtml(link)}">${escapeHtml(link)}</a>`,
      );
    else document.execCommand('createLink', false, link);
    patch({ html: editor.current?.innerHTML ?? '' });
    setShowLink(false);
    setLink('');
  }
  const sendDisabled = !!busy || voice.recording || voice.busy;
  const listening = voice.recording || voice.preparing;
  const title =
    form.mode === 'new'
      ? 'New email'
      : form.mode === 'forward'
        ? 'Forward'
        : form.mode === 'reply-all'
          ? 'Reply all'
          : 'Reply';
  const rootClass = inline
    ? 'compose-inline'
    : popout
      ? 'compose-popout'
      : 'compose-layer' + (closing ? ' closing' : '');
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  // Another "write" request while this draft is open brings this one forward instead of opening a second composer.
  const [nudged, setNudged] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const nudge = () => {
      setNudged(false);
      requestAnimationFrame(() => setNudged(true));
      clearTimeout(timer);
      timer = setTimeout(() => setNudged(false), 700);
      editor.current?.focus();
    };
    addEventListener('aplos:compose-nudge', nudge);
    return () => {
      removeEventListener('aplos:compose-nudge', nudge);
      clearTimeout(timer);
    };
  }, []);
  const [savedFlash, setSavedFlash] = useState(false);
  const wasSaving = useRef(false);
  useEffect(() => {
    if (!saved) {
      wasSaving.current = true;
      setSavedFlash(false);
      return;
    }
    if (!wasSaving.current) return;
    wasSaving.current = false;
    setSavedFlash(true);
    const timer = setTimeout(() => setSavedFlash(false), 1600);
    return () => clearTimeout(timer);
  }, [saved]);
  const hasFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  // Focusing the editor only scrolls its first line into view; reveal the whole reply card under the thread.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!inline) return;
    const frame = requestAnimationFrame(() =>
      rootRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: reducedMotion() ? 'auto' : 'smooth',
      }),
    );
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div
      ref={rootRef}
      className={rootClass}
      onMouseDown={e => {
        if (e.target === e.currentTarget && !popout && !inline) void leave();
      }}
    >
      <section
        className={cx(
          'composer',
          dragging && 'is-dropping',
          nudged && 'is-nudged',
          listening && 'is-listening',
        )}
        role={inline ? 'region' : 'dialog'}
        aria-modal={inline ? undefined : true}
        aria-label={inline ? 'Reply' : 'Compose email'}
        onDragEnter={e => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current++;
          setDragging(true);
        }}
        onDragOver={e => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={e => {
          if (!hasFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDragging(false);
        }}
        onDrop={e => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragging(false);
          receive(Array.from(e.dataTransfer.files), !!editor.current?.contains(e.target as Node));
        }}
      >
        <VoiceGlow active={listening} level={voice.level} />
        {dragging && (
          <div className="compose-drop" aria-hidden="true">
            <Paperclip size={20} />
            <span>
              Drop to attach<small>Images dropped in the message appear inline</small>
            </span>
          </div>
        )}
        <header className="compose-header">
          <div className="title-with-icon">
            {inline && thread && form.mode !== 'forward' ? (
              <>
                <Button
                  variant="ghost"
                  className={cx('mode-button', modeMenu.open && 'is-open')}
                  aria-label="Reply type"
                  aria-haspopup="menu"
                  aria-expanded={modeMenu.open}
                  icon={form.mode === 'reply-all' ? ReplyAll : Reply}
                  iconRight={ChevronDown}
                  onClick={modeMenu.toggle}
                >
                  {title}
                </Button>
                <Menu
                  open={modeMenu.open}
                  anchor={modeMenu.anchor}
                  onClose={modeMenu.close}
                  placement="bottom-start"
                  label="Reply type"
                  groups={[
                    [
                      {
                        label: 'Reply',
                        icon: Reply,
                        checked: form.mode === 'reply',
                        onSelect: () => changeMode('reply'),
                      },
                      {
                        label: 'Reply all',
                        icon: ReplyAll,
                        checked: form.mode === 'reply-all',
                        onSelect: () => changeMode('reply-all'),
                      },
                    ],
                  ]}
                />
              </>
            ) : (
              <strong>{title}</strong>
            )}
            <span
              className={cx('save-status', !saved && 'is-saving', savedFlash && 'is-saved')}
              aria-live="polite"
            >
              {!saved ? (
                <>
                  <Spinner size={12} />
                  Saving
                </>
              ) : (
                savedFlash && (
                  <>
                    <Check size={12} />
                    Saved
                  </>
                )
              )}
            </span>
          </div>
          <div className="actions">
            {!popout && (
              <IconButton
                label="Open in separate window"
                icon={ArrowUpRight}
                iconSize={18}
                onClick={() => void finish('popout')}
                disabled={!!busy}
              />
            )}
            <IconButton
              label="Discard draft"
              icon={Trash2}
              iconSize={17}
              onClick={async () => {
                if (
                  blank() ||
                  (await confirmAction({
                    title: 'Discard this draft?',
                    message: 'The draft and its attachments will be deleted.',
                    confirmLabel: 'Discard',
                    danger: true,
                  }))
                )
                  await finish('discard');
              }}
            />
            {popout && (
              <IconButton
                label="Close"
                shortcut="Esc"
                icon={X}
                iconSize={18}
                onClick={() => void leave()}
              />
            )}
            {listening ? (
              <Button
                variant="primary"
                className="send-button is-recording"
                tooltip={{ content: 'Finish recording', detail: 'Esc to cancel' }}
                onClick={voice.stop}
              >
                <LevelMeter level={voice.level} bars={4} />
                Recording
              </Button>
            ) : (
              <Button
                variant="primary"
                className={cx('send-button', form.to.trim() && 'ready')}
                icon={Send}
                loading={busy === 'send' || voice.busy}
                tooltip={{
                  content: form.to.trim() ? 'Send' : 'Add a recipient to send',
                  shortcut: '⌘ ↵',
                }}
                onClick={() => void finish('send')}
                disabled={sendDisabled}
              >
                Send
              </Button>
            )}
          </div>
        </header>
        <div className="compose-fields">
          <div className="field-line from-line">
            <label htmlFor="compose-from">From</label>
            <button
              type="button"
              id="compose-from"
              className={cx('from-display', fromMenu.open && 'is-open')}
              aria-haspopup="menu"
              aria-expanded={fromMenu.open}
              disabled={!!busy}
              onClick={fromMenu.toggle}
            >
              {senderAvatar(sendingAccount, senderName || fromEmail)}
              <span className="from-name">{senderName}</span>
              <span className="from-email">{fromEmail}</span>
              <ChevronsUpDown size={13} />
            </button>
            <Menu
              open={fromMenu.open}
              anchor={fromMenu.anchor}
              onClose={fromMenu.close}
              placement="bottom-start"
              label="Send from"
              className="from-menu"
              groups={[senderItems]}
            />
          </div>
          <div className="field-line">
            <label htmlFor="compose-to">To</label>
            <RecipientInput
              id="compose-to"
              autoFocus={!form.to && !holdToTalk?.()}
              value={form.to}
              disabled={!!busy}
              names={names}
              contacts={contacts}
              placeholder="name@example.com"
              onChange={to => patch({ to })}
            />
            {!expanded && (
              <Button
                variant="text"
                size="sm"
                className="cc-toggle"
                onClick={() => setExpanded(true)}
              >
                Cc/Bcc
              </Button>
            )}
          </div>
          {expanded && (
            <>
              <div className="field-line field-reveal">
                <label htmlFor="compose-cc">Cc</label>
                <RecipientInput
                  id="compose-cc"
                  value={form.cc}
                  disabled={!!busy}
                  names={names}
                  contacts={contacts}
                  onChange={cc => patch({ cc })}
                />
              </div>
              <div className="field-line field-reveal">
                <label htmlFor="compose-bcc">Bcc</label>
                <RecipientInput
                  id="compose-bcc"
                  value={form.bcc}
                  disabled={!!busy}
                  names={names}
                  contacts={contacts}
                  onChange={bcc => patch({ bcc })}
                />
              </div>
            </>
          )}
          <div className="field-line subject-line">
            <input
              id="compose-subject"
              aria-label="Subject"
              value={form.subject}
              disabled={!!busy}
              onChange={e => patch({ subject: e.target.value })}
              placeholder="Subject"
            />
          </div>
        </div>
        <div
          className="compose-body"
          onMouseDown={e => {
            const el = editor.current;
            if (
              !el ||
              busy ||
              el.contains(e.target as Node) ||
              (e.target as HTMLElement).closest('a,button,input')
            )
              return;
            e.preventDefault();
            el.focus();
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
          }}
        >
          {bodyEmpty(form.html) && !listening && !voice.busy && (
            <div className="compose-placeholder" aria-hidden="true">
              Hold<Kbd>Space</Kbd>to talk
            </div>
          )}
          {suggestionShown() && (
            <div className="compose-suggestion">
              <button className="suggestion-chip" onClick={takeSuggestion}>
                <Reply size={14} />
                <span>{suggested}</span>
                <Kbd size="sm">Tab</Kbd>
              </button>
              <IconButton
                size="xs"
                label="Dismiss suggestion"
                tooltip={false}
                icon={X}
                onClick={() => setSuggested(undefined)}
              />
            </div>
          )}
          <div
            ref={editor}
            className="rich-editor"
            contentEditable={!busy}
            onKeyDown={e => {
              if (e.key === 'Tab' && !e.shiftKey && suggestionShown()) {
                e.preventDefault();
                takeSuggestion();
              }
            }}
            suppressContentEditableWarning
            role="textbox"
            aria-label="Message body"
            aria-multiline="true"
            onInput={() => patch({ html: editor.current?.innerHTML ?? '' })}
            onPaste={e => {
              e.preventDefault();
              const pasted = Array.from(e.clipboardData.files);
              if (pasted.length) {
                receive(pasted, true);
                return;
              }
              const html = e.clipboardData.getData('text/html');
              document.execCommand(
                'insertHTML',
                false,
                html
                  ? DOMPurify.sanitize(html)
                  : escapeHtml(e.clipboardData.getData('text/plain')).replace(/\n/g, '<br>'),
              );
              patch({ html: editor.current?.innerHTML ?? '' });
            }}
          />
          {signatureOn &&
            (signatureSource === 'account' ? (
              accountSignature ? (
                <div
                  className="signature-preview"
                  dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(accountSignature) }}
                />
              ) : (
                <p className="small muted">
                  {sendingAccount?.sendAs
                    ? 'No account signature is set for this sending address.'
                    : 'Account signatures are unavailable. Sync or reconnect this account.'}
                </p>
              )
            ) : (
              settings.signature && <div className="signature-preview">{settings.signature}</div>
            ))}
          {settings.footer && <p className="muted small">Sent with Aplos Mail</p>}
        </div>
        {form.attachments.length > 0 && (
          <div className="compose-attachments">
            {form.attachments.map(a => (
              <span className="attachment attachment-enter" key={a.id}>
                <Paperclip size={13} />
                {a.name}
                <span className="muted small">{Math.ceil(a.size / 1024)} KB</span>
                <IconButton
                  size="xs"
                  label={'Remove ' + a.name}
                  tooltip={false}
                  icon={X}
                  onClick={() =>
                    patch({ attachments: form.attachments.filter(x => x.id !== a.id) })
                  }
                />
              </span>
            ))}
          </div>
        )}
        {sendingAccount?.error && (
          <Notice tone="amber" className="compose-notice">
            {sendingAccount.error}
          </Notice>
        )}
        {error && (
          <Notice
            className="compose-notice"
            action={
              (form.sendAttemptAt || draft.sendAttemptAt) && error === draft.sendError ? (
                <Button
                  variant="text"
                  size="sm"
                  onClick={async () => {
                    if (
                      !(await confirmAction({
                        title: 'Send this message again?',
                        message:
                          'If the earlier attempt was delivered, recipients will get two copies. Check Sent mail first if you can.',
                        confirmLabel: 'Send anyway',
                        danger: true,
                      }))
                    )
                      return;
                    resend.current = true;
                    await finish('send');
                    resend.current = false;
                  }}
                >
                  Send anyway
                </Button>
              ) : undefined
            }
          >
            {error}
          </Notice>
        )}
        {(busy === 'polish' || busy === 'draft') && (
          <div className="compose-ai compose-strip">
            <Spinner size={15} />
            <span>{busy === 'polish' ? 'Polishing…' : 'Writing…'}</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                stopWork();
                working('');
              }}
            >
              Cancel
            </Button>
          </div>
        )}
        {showLink && (
          <div className="link-editor compose-strip">
            <Link size={15} />
            <input
              autoFocus
              aria-label="Link URL"
              placeholder="https://…"
              value={link}
              onChange={e => setLink(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  insertLink();
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setShowLink(false);
                }
              }}
            />
            <Button variant="ghost" size="sm" disabled={!link.trim()} onClick={insertLink}>
              Insert link
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowLink(false)}>
              Cancel
            </Button>
          </div>
        )}
        <footer className="compose-footer">
          <div className="actions compose-tools">
            <Button
              variant="text"
              size="sm"
              icon={SpellCheck}
              className="polish-button"
              loading={busy === 'polish'}
              tooltip={{
                content: `Polish with ${askModelLabel(settings.draftModel, 'draft').provider}`,
                detail: 'Fix grammar and tone without changing meaning',
                placement: 'top',
              }}
              disabled={!!busy || !plain(form.html).trim()}
              onClick={() => void ai('polish', '')}
            >
              {busy === 'polish' ? 'Polishing…' : 'Polish'}
            </Button>
            <span className="separator" />
            <IconButton
              label="Bold"
              shortcut="⌘ B"
              placement="top"
              icon={Bold}
              iconSize={16}
              onMouseDown={e => e.preventDefault()}
              onClick={() => format('bold')}
            />
            <IconButton
              label="Italic"
              shortcut="⌘ I"
              placement="top"
              icon={Italic}
              iconSize={16}
              onMouseDown={e => e.preventDefault()}
              onClick={() => format('italic')}
            />
            <IconButton
              label="Underline"
              shortcut="⌘ U"
              placement="top"
              icon={Underline}
              iconSize={16}
              onMouseDown={e => e.preventDefault()}
              onClick={() => format('underline')}
            />
            <IconButton
              label="Strikethrough"
              shortcut="⌘ ⇧ X"
              placement="top"
              className="tool-extra"
              icon={Strikethrough}
              iconSize={16}
              onMouseDown={e => e.preventDefault()}
              onClick={() => format('strikeThrough')}
            />
            <span className="separator tool-extra" />
            <IconButton
              label="Bulleted list"
              placement="top"
              className="tool-extra"
              icon={List}
              iconSize={16}
              onMouseDown={e => e.preventDefault()}
              onClick={() => format('insertUnorderedList')}
            />
            <IconButton
              label="Numbered list"
              placement="top"
              className="tool-extra"
              icon={ListOrdered}
              iconSize={16}
              onMouseDown={e => e.preventDefault()}
              onClick={() => format('insertOrderedList')}
            />
            <IconButton
              label="Quote"
              placement="top"
              className="tool-extra"
              icon={TextQuote}
              iconSize={16}
              onMouseDown={e => e.preventDefault()}
              onClick={quote}
            />
            <span className="separator" />
            <IconButton
              label="Insert link"
              placement="top"
              icon={Link}
              iconSize={16}
              active={showLink}
              onMouseDown={e => e.preventDefault()}
              onClick={toggleLink}
            />
            <IconButton
              label="Insert inline image"
              placement="top"
              icon={ImageIcon}
              iconSize={16}
              onClick={() => imageInput.current?.click()}
            />
          </div>
          <div className="actions">
            <span className="compose-signature">
              <Checkbox
                className="signature-toggle"
                label="Signature"
                checked={form.signature}
                disabled={!!busy}
                onChange={signature => patch({ signature })}
              />
              {sendingAccount &&
                sendingAccount.provider !== 'demo' &&
                sendingAccount.capabilities?.signatures !== false && (
                  <Select
                    className="signature-source"
                    label="Signature source"
                    value={signatureSource}
                    disabled={!!busy}
                    options={[
                      { value: 'custom', label: 'Custom' },
                      {
                        value: 'account',
                        label: sendingAccount.provider === 'google' ? 'Gmail' : 'Account',
                      },
                    ]}
                    onChange={value => patch({ signatureSource: value })}
                  />
                )}
              <span className="separator" />
            </span>
            <Button
              variant="text"
              size="sm"
              icon={Paperclip}
              className="attach-button"
              loading={busy === 'attach'}
              onClick={() => file.current?.click()}
            >
              Attach
            </Button>
          </div>
        </footer>
        <input
          type="file"
          ref={file}
          hidden
          multiple
          onChange={e => {
            void attach(e.target.files);
            e.target.value = '';
          }}
        />
        <input
          type="file"
          ref={imageInput}
          hidden
          accept="image/*"
          onChange={e => {
            void attach(e.target.files, true);
            e.target.value = '';
          }}
        />
      </section>
      <button
        type="button"
        className={cx('compose-hint', listening && 'is-listening')}
        disabled={!!busy && !listening}
        aria-live="polite"
        onMouseDown={e => e.preventDefault()}
        onPointerDown={e => {
          if (e.button !== 0 || hold.current) return;
          if (voice.isActive()) voice.stop();
          else if (!operation.current && !terminal.current) press('pointer');
        }}
        onClick={e => {
          if (e.detail === 0) voice.toggle();
        }}
      >
        <span
          className="compose-hint-text"
          key={
            voice.preparing ? 'preparing' : listening ? 'listening' : voice.busy ? 'busy' : 'idle'
          }
        >
          {voice.preparing ? (
            <>
              Getting the microphone ready…
              <span className="compose-hint-gap" />
              <Kbd>Esc</Kbd>to cancel
            </>
          ) : listening ? (
            <>
              {hold.current?.source === 'key' ? (
                <>
                  Release<Kbd>Space</Kbd>to transcribe
                </>
              ) : hold.current ? (
                'Release to transcribe'
              ) : (
                'Click to transcribe'
              )}
              <span className="compose-hint-gap" />
              <Kbd>Esc</Kbd>to cancel
            </>
          ) : voice.busy ? (
            <>
              <Spinner size={14} />
              Transcribing with {askModelLabel(settings.voiceModel, 'voice').provider}…
            </>
          ) : (
            <>
              Hold<Kbd>Space</Kbd>to talk
            </>
          )}
        </span>
      </button>
    </div>
  );
}
