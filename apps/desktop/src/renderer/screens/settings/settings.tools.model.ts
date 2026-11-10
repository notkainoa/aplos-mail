/**
 * The pure rules of "Tools on this Mac": what a tool may be allowed to do (in plain words), when the Add form can
 * be submitted, what the device-sync row says. The grant itself goes through `Clients/grant`; the key file's path
 * is shown once by the dialog and is never part of this state (ARCH 12.3).
 */
import type { Input, Output } from '../../data';

export type WorkflowInfo = Output<'Workflow/status'>;

export type ToolKind = 'cli' | 'mcp' | 'preview' | 'phone';
/** The permissions `Clients/grant` accepts, straight from the contract's `GrantableScope` (ARCH 12.3). */
export type ToolScope = Input<'Clients/grant'>['scopes'][number];

export const TOOL_KIND_ITEMS: readonly { id: ToolKind; label: string }[] = [
  { id: 'cli', label: 'Command line' },
  { id: 'mcp', label: 'MCP' },
  { id: 'preview', label: 'Preview' },
  { id: 'phone', label: 'Phone' },
];

export interface ToolScopeChoice {
  readonly id: ToolScope;
  readonly label: string;
  /** Shown only while the choice is ticked, for the permissions that act for you. */
  readonly warning?: string;
}

export const TOOL_SCOPES: readonly ToolScopeChoice[] = [
  { id: 'read', label: 'Read your mail and calendar' },
  { id: 'triage', label: 'Move mail: Done, Later, Trash' },
  { id: 'draft', label: 'Write drafts' },
  { id: 'send', label: 'Send mail', warning: 'Send lets this tool send mail as you.' },
  { id: 'ai', label: 'Use your AI providers' },
  {
    id: 'admin',
    label: 'Change settings and accounts',
    warning: 'This tool could change your settings and disconnect accounts.',
  },
];

/** What a new tool starts with: it may read, nothing more. */
export const DEFAULT_TOOL_SCOPES: readonly ToolScope[] = ['read'];

export interface ToolDraft {
  readonly name: string;
  readonly kind: ToolKind;
  readonly scopes: readonly ToolScope[];
}

export const EMPTY_TOOL_DRAFT: ToolDraft = {
  name: '',
  kind: 'cli',
  scopes: DEFAULT_TOOL_SCOPES,
};

/** The Add button needs a name and at least one permission, the same two rules the engine enforces. */
export function toolDraftReady(draft: ToolDraft): boolean {
  return draft.name.trim() !== '' && draft.scopes.length > 0;
}

/** The scopes in the order the list shows them, however they were ticked. */
export function toggleScope(scopes: readonly ToolScope[], id: ToolScope, on: boolean): ToolScope[] {
  const next = new Set(scopes);
  if (on) next.add(id);
  else next.delete(id);
  return TOOL_SCOPES.map(s => s.id).filter(s => next.has(s));
}

/** An MCP tool reaches only reading and drafting today; the other permissions would be stored and never used. */
export function kindNote(kind: ToolKind, scopes: readonly ToolScope[]): string | null {
  if (kind !== 'mcp') return null;
  return scopes.some(s => s === 'triage' || s === 'send' || s === 'admin')
    ? 'MCP tools can only read and write drafts for now, so the other permissions do nothing yet.'
    : null;
}

/** The sentences under the ticked permissions that act for you. */
export function scopeWarnings(scopes: readonly ToolScope[]): readonly string[] {
  return TOOL_SCOPES.filter(s => s.warning && scopes.includes(s.id)).map(s => s.warning!);
}

/** A tool as the list holds it: the key file's path is shown once, by the dialog, and kept nowhere else. */
export function withoutKeyPath<T extends { tokenPath?: string }>(client: T): Omit<T, 'tokenPath'> {
  const { tokenPath: _path, ...rest } = client;
  return rest;
}

export const TOOL_KEY_NOTE =
  'The tool reads its key from this file. Aplos never shows the key itself. Any program running as you can read the file, and whoever has it can act as this tool. This path is shown once.';

/** The Revoke question: what stops and that it is quick. */
export function revokeConfirm(name: string): { question: string; consequence: string } {
  return {
    question: `Revoke “${name}”?`,
    consequence:
      'It stops working right away and its open connections close. The key file no longer opens anything, but it may still be on this Mac. You can allow the tool again with a new key file.',
  };
}

/** The second ask for 'admin' — it can move the app itself, so Allow is not the only question (DESIGN 10). */
export function adminGrantConfirm(name: string): { question: string; consequence: string } {
  return {
    question: `Give “${name}” admin access?`,
    consequence:
      'It can change this app’s settings, accounts and other tools. You can revoke it at any time.',
  };
}

/** The failure line when the engine may have committed a grant before it stopped answering (DESIGN 10). */
export const GRANT_UNCONFIRMED_LINE =
  'We couldn’t confirm that the tool was allowed. Check the list of tools before trying again.';

/**
 * Whether a `Clients/grant` rejection may hide a committed write: `unavailable` and `notImplemented` can land
 * after the engine already wrote, so a Retry could make a second tool. A `ContractError`'s `body.type` is read
 * first — a cloned error can keep only its body — then its own `type`; anything else is a plain refusal.
 */
export function grantUnconfirmed(error: unknown): boolean {
  if (error === null || typeof error !== 'object') return false;
  const body = (error as { body?: unknown }).body;
  const bodyType =
    body !== null && typeof body === 'object' ? (body as { type?: unknown }).type : undefined;
  const type = bodyType ?? (error as { type?: unknown }).type;
  return type === 'notImplemented' || type === 'unavailable';
}

/** The device-sync row: one calm sentence, and whether any control can exist yet. */
export function workflowLine(status: WorkflowInfo | undefined): string {
  if (!status || !status.available) return 'Device sync comes in a later version.';
  return status.enabled ? 'On. Done and Later follow you between Macs.' : 'Off.';
}
