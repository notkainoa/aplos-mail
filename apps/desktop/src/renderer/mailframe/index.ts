// The mail frame host (plan 30 section 4.4). Screens import MailFrame and its types from here.
export { MailFrame } from './MailFrame';
export { MailFrameView, type MailFrameViewProps } from './MailFrameView';
export { KEY_LAYER_ATTRIBUTE } from './layers';
export { foldsQuoted, quotedRangesFor, quotedRangesOf, type QuotedRange } from './quoted';
export { sanitiseBody, type SanitisedBody } from './sanitise';
export type {
  FrameSource,
  ImagePolicy,
  MailFrameKey,
  MailFrameProps,
  MailFrameReady,
} from './types';
