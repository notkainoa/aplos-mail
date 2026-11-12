// The browser spec's page: the legacy reader's body preparation, exposed on `window` for the spec to call.
import { prepareMessageBody } from '../mailBody';

(window as unknown as { prepareMessageBody: typeof prepareMessageBody }).prepareMessageBody =
  prepareMessageBody;
