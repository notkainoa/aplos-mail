import type { AppState, Thread } from './types';

/**
 * One committed change to the mailbox, as sent to windows. `epoch` identifies one engine run and `rev`
 * counts commits within it, so a receiver can tell a missed change from an old one. Collections other
 * than threads are small and arrive whole; threads arrive as changed rows and removed IDs.
 */
export interface StateChanges {
  epoch:string;
  rev:number;
  threads?:{put:Thread[]; remove:string[]};
  accounts?:AppState['accounts'];
  drafts?:AppState['drafts'];
  events?:AppState['events'];
  conversations?:AppState['conversations'];
  settings?:AppState['settings'];
  selectedAccountId?:string;
  sync?:AppState['sync'];
  blockedSenders?:string[];
}

const FIELDS=['accounts','drafts','events','conversations','settings','selectedAccountId','sync','blockedSenders'] as const;

/** Threads newest first, ties broken by ID, the order pages are read in. */
export const threadOrder=(a:Pick<Thread,'date'|'id'>,b:Pick<Thread,'date'|'id'>)=>b.date.localeCompare(a.date)||(a.id<b.id?-1:a.id>b.id?1:0);

/** A new state with the changes applied. Unchanged threads keep their object identity. */
export function applyChanges(state:AppState, changes:StateChanges):AppState {
  const next:AppState={...state,epoch:changes.epoch,rev:changes.rev};
  for(const key of FIELDS)if(changes[key]!==undefined)(next as unknown as Record<string,unknown>)[key]=changes[key];
  if(changes.threads){
    const removed=new Set(changes.threads.remove),put=new Map(changes.threads.put.map(t=>[t.id,t]));
    const threads=state.threads.filter(t=>!removed.has(t.id)).map(t=>{const fresh=put.get(t.id);if(fresh)put.delete(t.id);return fresh??t;});
    next.threads=[...threads,...put.values()];
  }
  return next;
}

export interface ThreadPage { epoch:string; rev:number; threads:Thread[]; /** Where the next page starts; absent on the last page. */ next?:{date:string;id:string} }

/**
 * A window's copy of the mailbox. It starts from a snapshot that may hold only the newest threads,
 * applies changes in order, and asks for a fresh snapshot when it misses one. Older threads arrive in
 * pages; a page never brings back a thread that a later change removed or overwrites a newer copy.
 */
export function createLiveState(handlers:{update(state:AppState):void; resync():void}) {
  let state:AppState|undefined;
  /** Changes that arrived before the first snapshot or after a gap, replayed onto the next snapshot. */
  let buffered:StateChanges[]=[];
  let stale=false;
  /** Threads removed since paging began, which an older page must not restore. */
  let removedSincePaging=new Set<string>();
  function apply(changes:StateChanges) {
    if(state&&!stale){
      const rev=state.rev??0;
      if(changes.epoch===state.epoch&&changes.rev<=rev)return;
      if(changes.epoch===state.epoch&&changes.rev===rev+1){
        for(const id of changes.threads?.remove??[])removedSincePaging.add(id);
        state=applyChanges(state,changes);handlers.update(state);return;
      }
      stale=true;handlers.resync();
    }
    buffered.push(changes);if(buffered.length>500)buffered.shift();
  }
  return {
    get state(){return state;},
    /** Replace the copy with a snapshot, then replay newer changes that arrived while it was loading. */
    snapshot(next:AppState) {
      if(state&&!stale&&next.epoch===state.epoch&&(next.rev??0)<(state.rev??0))return;
      state=next;stale=false;removedSincePaging=new Set();
      const pending=buffered.filter(c=>c.epoch===next.epoch&&c.rev>(next.rev??0)).sort((a,b)=>a.rev-b.rev);buffered=[];
      handlers.update(state);
      for(const changes of pending)apply(changes);
    },
    apply,
    /** Add older threads from a page. Returns false when the page belongs to another engine run. */
    page(page:ThreadPage):boolean {
      if(!state||page.epoch!==state.epoch)return false;
      const known=new Set(state.threads.map(t=>t.id));
      const older=page.threads.filter(t=>!known.has(t.id)&&!removedSincePaging.has(t.id));
      if(older.length){state={...state,threads:[...state.threads,...older]};handlers.update(state);}
      return true;
    },
  };
}
