// The composer (DESIGN 7.6): the inline reply under a thread, the compose page, and the undo-send notice the shell's
// toast stack shows when no thread is visible. The stylesheet is ./compose.css (REQUEST: screens.css imports it).
export { ComposeScreen, type ComposeScreenProps } from './ComposeScreen';
export { composeHeader, COMPOSE_CRUMB } from './composeHeader';
export { InlineReplyHost, type InlineReplyHostProps } from './InlineReplyHost';
export { useUndoSendNotice } from './runtime/useUndoSendNotice';
export { useDictation, type DictationHook } from './runtime/useDictation';
export {
  canRecord,
  fakeDictationSource,
  mediaRecorderSource,
  type DictationSource,
  type Recording,
} from './runtime/dictationSource';
