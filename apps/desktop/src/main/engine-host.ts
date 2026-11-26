import { app } from 'electron';
import { sweepAttachmentTemp } from './native-methods';
import { dataDirOverride } from './test-mode';
import { bootRealEngine, realEngine } from './engine-real';
import { registerMailScheme } from './mail-protocol';

/** The engine's data folder: the test or development override, else the app's own folder. */
const dataFolder = () => dataDirOverride ?? app.getPath('userData');
// The sealed mail frame's scheme (html-5): registered at import, before app ready as Electron requires.
registerMailScheme();

/** `noteExit` counts an engine stop toward the park (lifecycle.ts). */
async function bootEngine(hooks: { noteExit(): boolean; noteRestart?(): void }) {
  // Folders an opened attachment left in the temp directory in earlier sessions.
  void sweepAttachmentTemp().catch(() => undefined);
  return bootRealEngine({
    dataDir: dataFolder(),
    noteExit: hooks.noteExit,
    ...(hooks.noteRestart ? { noteRestart: hooks.noteRestart } : {}),
  });
}

export { bootEngine, realEngine };
