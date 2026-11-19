// The status family (DESIGN 6): plain first implementations behind the frozen props in ../props.ts.
// Styles live in ./status.css, which builds on ../surfaces/surfaces.css (buttons, keycaps, dialog). TSX never imports CSS.
export { FatalScreen } from './FatalScreen';
export { ProgressSegments } from './ProgressSegments';
export { ReconnectSheet } from './ReconnectSheet';
export { Spinner } from './Spinner';
export { StatusSlot, statusCopy, syncedLine } from './StatusSlot';
export type { StatusCopy } from './StatusSlot';
