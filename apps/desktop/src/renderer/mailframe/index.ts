// The mail frame host (plan 30 section 4.4). Screens import MailFrame and its types from here.
export { MailFrame } from './MailFrame';
export { MailFrameView, type MailFrameViewProps } from './MailFrameView';
export { sanitiseBody, type SanitisedBody } from './sanitise';
export type {
  FrameSource,
  ImagePolicy,
  MailFrameKey,
  MailFrameProps,
  MailFrameReady,
} from './types';
