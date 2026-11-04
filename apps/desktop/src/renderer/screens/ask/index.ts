// The Ask dock and the Today tab (lane ui-ask, DESIGN §7.7). `AskDockHost` is the dock content the shell mounts in
// its dock slot; `TodayHost` is the agenda it hosts on the Today tab. `askStore` holds the shared state so the
// palette's Ask row, the pane-header buttons and the keys reach the same dock (see REQUESTS.md).
export { AskDockHost, type AskDockHostProps } from './AskDockHost';
export { AskPanel, type AskPanelProps, type AskPanelHandlers } from './AskPanel';
export { askStore, useDock, defaultDockWidth, type DockState } from './askStore';
export { TodayHost } from '../today/TodayHost';
