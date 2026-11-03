import assert from 'node:assert/strict';
import { eventChangeKey, type StorePort } from '../../src/store';

/*
 * The change-log property's client model (ARCH 3.5, FR-15), shared by the property test and the account tests: a client
 * holding snapshot(seqK) that applies every change row after K, re-reading each `u` item and every item of a `*` type,
 * ends with exactly snapshot(seqN).
 */

export type Snapshot = Map<string, string>; // `${type}\0${id}` → canonical JSON

/** The contract-visible state, read straight from the tables; derived numbers are recomputed here, not trusted. */
export function snapshot(store: StorePort): Snapshot {
  const out: Snapshot = new Map();
  const put = (type: string, id: string, value: unknown) =>
    out.set(`${type}\0${id}`, JSON.stringify(value));
  store.read(q => {
    for (const a of q.all(
      'SELECT a.*, (SELECT count(*) FROM ops o WHERE o.account_id = a.id) AS pending_changes FROM accounts a',
    ))
      put('Account', String(a.id), a);
    for (const c of q.all('SELECT account_id, remote_id, name, hidden, selected FROM calendars'))
      put('Calendar', `${c.account_id}:${c.remote_id}`, c);
    for (const e of q.all(
      `SELECT c.account_id, c.remote_id AS cal, e.remote_id,
        json_group_array(json_array(e.recurrence_id, e.status, e.start_utc, e.data)) AS rows
      FROM (SELECT * FROM events ORDER BY recurrence_id) e JOIN calendars c ON c.id = e.calendar_id
      GROUP BY c.account_id, c.remote_id, e.remote_id`,
    ))
      put('Event', `${e.account_id}:${eventChangeKey(String(e.cal), String(e.remote_id))}`, e);
    for (const f of q.all(
      `SELECT f.account_id, f.remote_id, f.name, f.role, f.kind, f.hidden,
        (SELECT count(*) FROM thread_folders tf WHERE tf.folder_id = f.id) AS total,
        (SELECT count(*) FROM thread_folders tf WHERE tf.folder_id = f.id AND tf.unread > 0) AS unread
      FROM folders f`,
    ))
      put('Folder', `${f.account_id}:${f.remote_id}`, f);
    for (const t of q.all(
      `SELECT t.*, w.status, w.later_until, w.bookmarked, w.lane, w.importance,
        (SELECT json_group_array(f.remote_id) FROM (SELECT f.remote_id FROM thread_folders tf JOIN folders f ON f.id = tf.folder_id
          WHERE tf.thread_id = t.id ORDER BY f.remote_id) f) AS lists
      FROM threads t JOIN thread_workflow w ON w.thread_id = t.id`,
    )) {
      const { id: _internal, ...row } = t;
      put('Thread', `${t.account_id}:${t.remote_id}`, row);
    }
    for (const m of q.all(
      `SELECT m.*, t.remote_id AS thread,
        (SELECT json_group_array(x.remote_id) FROM (SELECT f.remote_id FROM message_folders mf JOIN folders f ON f.id = mf.folder_id
          WHERE mf.message_id = m.id ORDER BY f.remote_id) x) AS labels
      FROM messages m JOIN threads t ON t.id = m.thread_id`,
    )) {
      const { id: _internal, thread_id: _thread, ...row } = m;
      put('Message', `${m.account_id}:${m.remote_id}`, row);
    }
  });
  return out;
}

/** What a client does with the change log: drop `d`, re-read `u`, re-read the whole type of the account for `*`. */
export function replay(
  from: Snapshot,
  store: StorePort,
  since: number,
  latest: Snapshot,
): Snapshot {
  const client = new Map(from);
  for (let seq = since, more = true; more;) {
    const page = store.changesSince(seq, { limit: 7 });
    assert.equal(page.status, 'ok');
    if (page.status !== 'ok') break;
    for (const c of page.changes) {
      const key = `${c.type}\0${c.id}`;
      if (c.op === 'd') client.delete(key);
      else if (c.op === 'u') {
        const now = latest.get(key);
        if (now === undefined) client.delete(key);
        else client.set(key, now);
      } else {
        const prefix = `${c.type}\0${c.id}:`;
        for (const k of [...client.keys()]) if (k.startsWith(prefix)) client.delete(k);
        for (const [k, v] of latest) if (k.startsWith(prefix)) client.set(k, v);
      }
    }
    seq = page.toSeq;
    more = page.hasMore;
  }
  return client;
}
