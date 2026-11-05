// The ⌘K command palette (lane ui-ask, DESIGN §7.9). The shell mounts `PaletteHost` in its overlay slot beside the
// sheet host; `requestPaletteOpen` is how a screen (Search's `>`) asks for it with a seeded query.
export { PaletteHost, type PaletteHostProps } from './PaletteHost';
export {
  consumePaletteQuery,
  onPaletteOpenRequest,
  paletteStore,
  requestPaletteOpen,
  resetPaletteStore,
} from './paletteStore';
export { onAskRequest, requestAsk } from './askRequests';
