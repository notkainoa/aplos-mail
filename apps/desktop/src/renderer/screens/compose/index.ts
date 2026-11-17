// The composer (DESIGN 7.6): the inline reply under a thread, the compose page, and the undo-send notice the shell's
// toast stack shows when no thread is visible. The stylesheet is ./compose.css (REQUEST: screens.css imports it).
export { ComposeScreen, type ComposeCardStyle, type ComposeScreenProps } from './ComposeScreen';
export { composeCrumb, composeHeader, COMPOSE_CRUMB } from './composeHeader';
export { PendingSent } from './views/PendingSent';
export { InlineReplyHost, type InlineReplyHostProps } from './InlineReplyHost';
export { openDraftAccount } from './runtime/useComposeSession';
export { useUndoSendNotice } from './runtime/useUndoSendNotice';
export { useDictation, type DictationHook } from './runtime/useDictation';
export {
  canRecord,
  fakeDictationSource,
  mediaRecorderSource,
  type DictationSource,
  type Recording,
} from './runtime/dictationSource';
