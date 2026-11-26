/** Window IDs, rather than renderer WebContents IDs, own editable drafts. */
export class DraftOwnership {
  private owners = new Map<string, number>();
  claim(draftId: string, windowId: number): boolean {
    const owner = this.owners.get(draftId);
    if (owner !== undefined && owner !== windowId) return false;
    this.owners.set(draftId, windowId);
    return true;
  }
  assertEditable(draftId: string, windowId: number): void {
    const owner = this.owners.get(draftId);
    if (owner !== undefined && owner !== windowId)
      throw new Error('This draft is being edited in another window.');
  }
  release(draftId: string, windowId: number): boolean {
    if (this.owners.get(draftId) !== windowId) return false;
    this.owners.delete(draftId);
    return true;
  }
  releaseWindow(windowId: number): string[] {
    const released: string[] = [];
    for (const [draftId, owner] of this.owners)
      if (owner === windowId) {
        this.owners.delete(draftId);
        released.push(draftId);
      }
    return released;
  }
}
export function draftMutationId(method: string, payload: unknown): string | undefined {
  if (!['draft.save', 'draft.send', 'draft.delete'].includes(method)) return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new Error('Invalid draft request.');
  const input = payload as Record<string, unknown>;
  const nested =
    input.draft && typeof input.draft === 'object' && !Array.isArray(input.draft)
      ? (input.draft as Record<string, unknown>)
      : {};
  const id = method === 'draft.save' ? nested.id : input.id;
  if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Invalid draft ID.');
  return id;
}
