// Baseline-and-diff scan of the main checkout's node_modules trees — the tripwire for
// writes that reach past a worktree's linked dependencies into the shared install. The
// pre-agent pass (snapshotModuleTrees) records a bounded baseline; the post-agent pass
// (findModuleChanges) re-walks the same roots and reports ANY difference, so a write
// hidden by a restored mtime still shows. Both passes share one traversal so covered
// and skipped spots agree exactly.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Linter and bundler caches inside node_modules may be legitimately rewritten by the
// suite commands the worktrees run; they are the only directories the scan skips —
// and only REAL ones: a symlink with that name is followed like any other linked dir,
// because pruning it would hide writes the link carries somewhere else entirely.
const WRITE_SCAN_PRUNE = new Set(['.cache', '.vite']);
const WRITE_SCAN_LIMIT = 50;

// The per-directory part of a module-tree baseline: a hash of the sorted entry NAMES.
// Comparing it after the agent reports entries added, removed or renamed even when the
// directory's own mtime was restored afterwards — the hole a pure mtime scan leaves.
const hashNames = names => {
  const hash = createHash('sha256');
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
  }
  return hash.digest('hex');
};

// The per-entry part of the baseline: kind + size + mtimeMs for files, and for symlinks
// the link's own size/mtime plus the resolved target's — a write through an untouched
// link still moves the target's mtime. A same-size in-place content patch with the
// mtime restored stays invisible (ACCEPTED-RISK.md); everything else shows.
const entryRecord = (lst, tst) => {
  if (!lst.isSymbolicLink()) return `f:${lst.size}:${lst.mtimeMs}`;
  return `l:${lst.size}:${lst.mtimeMs}:${tst ? `${tst.size}:${tst.mtimeMs}` : 'x'}`;
};

// Marker a baseline records where a subdirectory could not be walked (perms, a race):
// the diff then flags that spot only when the failure pattern differs — a directory
// unwalkable at BOTH passes is an unchanged spot, not evidence.
const UNWALKABLE = 'unwalkable';

/**
 * The shared traversal for the baseline (snapshotModuleTrees) and the diff
 * (findModuleChanges) — both passes must cover exactly the same tree or every skipped
 * spot is a blind spot and every extra a false positive. Real directories dedup by
 * dev:ino, symlinked directories are followed once the same way (so hoisted workspace
 * links like node_modules/@scope/pkg are covered), .cache/.vite dirs are pruned, and
 * every callback gets the visitor's per-directory context. visit.dir returns the
 * context handed to entry/vanished for that dir's entries, or false to skip the
 * subtree. visit.unwalkable(dir, name, parentCtx) fires for a dir that cannot be
 * stat'ed or read (name/parentCtx null for the root); visit.vanished fires for an
 * entry that disappears between readdir and lstat.
 */
function scanModuleTree(root, visit) {
  const walk = (dir, name, parentCtx) => {
    let st;
    try {
      st = statSync(dir); // follows links: dedup key is the real directory
    } catch {
      visit.unwalkable?.(dir, name, parentCtx);
      return;
    }
    const key = `${st.dev}:${st.ino}`;
    if (visit.seen.has(key)) return;
    visit.seen.add(key);
    let names;
    try {
      names = readdirSync(dir);
    } catch {
      visit.unwalkable?.(dir, name, parentCtx);
      return;
    }
    names.sort(); // deterministic order: the same route reaches each dir at both passes
    const ctx = visit.dir(dir, st, key, names);
    if (ctx === false) return;
    for (const entryName of names) {
      if (visit.done?.()) return;
      const path = join(dir, entryName);
      let lst;
      try {
        lst = lstatSync(path);
      } catch {
        visit.vanished?.(path, entryName, ctx);
        continue;
      }
      if (lst.isSymbolicLink()) {
        let tst = null;
        try {
          tst = statSync(path);
        } catch {
          // Dangling link: the link itself still carries a recordable size/mtime.
        }
        visit.entry(path, entryName, lst, tst, ctx);
        // A symlinked dir is followed even under a pruned name: writes through it do
        // not land in a cache inside this tree — they reach wherever the link points.
        if (tst?.isDirectory()) walk(path, entryName, ctx);
      } else if (lst.isDirectory()) {
        if (!WRITE_SCAN_PRUNE.has(entryName)) walk(path, entryName, ctx);
      } else {
        visit.entry(path, entryName, lst, null, ctx);
      }
    }
  };
  walk(root, null, null);
}

/**
 * The pre-agent baseline of the watched main node_modules trees: for every directory a
 * hash of its sorted entry names plus its own mtime, for every other entry the
 * kind/size/mtime record above (symlinks also record the resolved target's stats).
 * Re-running the same walk after the agent — findModuleChanges — reports ANY
 * difference, not only mtimes newer than a stamp, so writes hidden by a restored mtime
 * still show (add/remove/rename through the name hash, size and mtime through the
 * entry records). `into` merges late-watched roots into an existing baseline — the
 * eval worktree's roots are linked after the agent ran and are baselined at link time.
 * Fail-closed: a root that cannot be walked throws, so the attempt is rejected with
 * the reason instead of watched against nothing. A full walk of this repo's
 * node_modules (~36k files) takes a few seconds, well under the write-scan budget.
 */
export function snapshotModuleTrees(roots, into = null) {
  const snap = into ?? { roots: new Map(), dirs: new Map() };
  for (const root of roots) {
    let st;
    try {
      st = statSync(root);
    } catch (error) {
      throw new Error(`cannot snapshot node_modules root ${root}: ${error.message}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`cannot snapshot node_modules root ${root}: not a directory`);
    }
    const key = `${st.dev}:${st.ino}`;
    // A root is identified by inode AND by the path(s) it was baselined under: two paths can
    // resolve to one inode, and an inode known under path A says nothing about path B.
    const known = snap.roots.get(key);
    if (known) {
      known.add(root);
      continue;
    }
    snap.roots.set(key, new Set([root]));
    scanModuleTree(root, {
      seen: new Set(snap.dirs.keys()),
      dir: (dir, dst, dkey, names) => {
        const rec = {
          path: dir,
          mtimeMs: dst.mtimeMs,
          names: hashNames(names),
          entries: new Map(),
        };
        snap.dirs.set(dkey, rec);
        return rec;
      },
      entry: (_path, name, lst, tst, rec) => {
        rec.entries.set(name, entryRecord(lst, tst));
      },
      unwalkable: (_dir, name, rec) => {
        // Keep an entry record when one exists (a symlink that failed to resolve);
        // only a real dir that could not be walked needs the marker.
        if (name !== null && rec && !rec.entries.has(name)) {
          rec.entries.set(name, UNWALKABLE);
        }
      },
    });
  }
  return snap;
}

/**
 * The post-agent half of the baseline check: re-walks the watched roots and reports
 * every difference — added, removed or renamed entries via the per-directory name
 * hash, size and mtime changes via the entry records (a write-through with the mtime
 * restored still differs by size, a rename with the directory mtime restored still
 * differs by names), entries appearing or vanishing mid-walk, and watched dirs or
 * roots that can no longer be walked at all. A watched root that is missing, no
 * longer a directory, never baselined under this path, or swapped under its own path (mv +
 * recreate, rm + mkdir — a new inode under an unchanged name — or a symlink to ANOTHER
 * baselined root, a known inode under the wrong name) is itself a hit: the audit must
 * never adopt a post-run inode as if it were the original tree. Bounded at
 * WRITE_SCAN_LIMIT hits: the first few are all a rejection reason needs.
 */
export function findModuleChanges(roots, snap, { relativeTo = null } = {}) {
  const hits = [];
  const push = path => {
    if (hits.length < WRITE_SCAN_LIMIT) {
      hits.push(relativeTo ? relative(relativeTo, path) : path);
    }
  };
  const visit = {
    seen: new Set(),
    done: () => hits.length >= WRITE_SCAN_LIMIT,
    unwalkable: (dir, name, rec) => {
      // The same spot unwalkable at the baseline is unchanged; anything else reports —
      // a watched root that cannot be re-walked is itself evidence.
      if (name === null || rec?.entries.get(name) !== UNWALKABLE) push(dir);
    },
    dir: (dir, st, key, names) => {
      const rec = snap.dirs.get(key);
      // A directory the baseline never saw — new, or an inode swapped under an old name.
      if (!rec || rec.path !== dir) {
        push(dir);
        return false;
      }
      if (rec.names !== hashNames(names) || rec.mtimeMs !== st.mtimeMs) push(dir);
      return rec;
    },
    entry: (path, name, lst, tst, rec) => {
      if (!rec || rec.entries.get(name) !== entryRecord(lst, tst)) push(path);
    },
    vanished: (path, name, rec) => {
      if (rec?.entries.has(name)) push(path);
    },
  };
  for (const root of roots) {
    if (hits.length >= WRITE_SCAN_LIMIT) break;
    let rootSt = null;
    try {
      rootSt = statSync(root); // follows links: the key is the real directory
    } catch {
      // Removed or unreadable — reported below.
    }
    // The root's inode must be baselined AND under THIS path: replacing node_modules (or a
    // workspace's) with a symlink to another baselined root keeps a known inode but is a swap.
    const baselined = rootSt?.isDirectory()
      ? snap.roots.get(`${rootSt.dev}:${rootSt.ino}`)
      : undefined;
    if (!baselined?.has(root)) {
      push(root);
      continue;
    }
    scanModuleTree(root, visit);
  }
  return hits;
}
