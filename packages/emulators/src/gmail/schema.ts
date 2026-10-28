/**
 * The field names of each Gmail response type, from the Gmail REST v1 reference. Google checks a
 * `fields=` mask against the response *type*, not the value, so a mask naming `nextPageToken` is
 * fine on the last page (where it is absent) while a typo such as `payload/header` is a 400.
 *
 * `true` marks a scalar (or a list of scalars); an object marks a nested resource.
 */
export interface Shape {
  [field: string]: Shape | true;
}

const leaves = (...names: string[]): Shape => Object.fromEntries(names.map(name => [name, true]));

const HEADER = leaves('name', 'value');
const PART_BODY = leaves('attachmentId', 'size', 'data');
/** MessagePart is recursive: `parts` holds more MessageParts. */
const PART: Shape = {
  ...leaves('partId', 'mimeType', 'filename'),
  headers: HEADER,
  body: PART_BODY,
};
PART.parts = PART;

export const MESSAGE: Shape = {
  ...leaves(
    'id',
    'threadId',
    'labelIds',
    'snippet',
    'historyId',
    'internalDate',
    'sizeEstimate',
    'raw',
  ),
  payload: PART,
  classificationLabelValues: { ...leaves('labelId'), fields: leaves('fieldId', 'selection') },
};

export const THREAD: Shape = { ...leaves('id', 'snippet', 'historyId'), messages: MESSAGE };
export const DRAFT: Shape = { id: true, message: MESSAGE };

export const LABEL: Shape = {
  ...leaves(
    'id',
    'name',
    'messageListVisibility',
    'labelListVisibility',
    'type',
    'messagesTotal',
    'messagesUnread',
    'threadsTotal',
    'threadsUnread',
  ),
  color: leaves('textColor', 'backgroundColor'),
};

const HISTORY_MESSAGE: Shape = { message: MESSAGE };
const HISTORY_LABEL: Shape = { message: MESSAGE, labelIds: true };
const HISTORY: Shape = {
  id: true,
  messages: MESSAGE,
  messagesAdded: HISTORY_MESSAGE,
  messagesDeleted: HISTORY_MESSAGE,
  labelsAdded: HISTORY_LABEL,
  labelsRemoved: HISTORY_LABEL,
};

export const FILTER: Shape = {
  id: true,
  criteria: leaves(
    'from',
    'to',
    'subject',
    'query',
    'negatedQuery',
    'hasAttachment',
    'excludeChats',
    'size',
    'sizeComparison',
  ),
  action: leaves('addLabelIds', 'removeLabelIds', 'forward'),
};

const SEND_AS: Shape = {
  ...leaves(
    'sendAsEmail',
    'displayName',
    'replyToAddress',
    'signature',
    'isPrimary',
    'isDefault',
    'treatAsAlias',
    'verificationStatus',
  ),
  smtpMsa: leaves('host', 'port', 'username', 'password', 'securityMode'),
};

const list = (key: string, item: Shape): Shape => ({
  [key]: item,
  nextPageToken: true,
  resultSizeEstimate: true,
});

export const RESPONSE = {
  profile: leaves('emailAddress', 'messagesTotal', 'threadsTotal', 'historyId'),
  watch: leaves('historyId', 'expiration'),
  labels: { labels: LABEL } as Shape,
  label: LABEL,
  history: { history: HISTORY, nextPageToken: true, historyId: true } as Shape,
  message: MESSAGE,
  messages: list('messages', MESSAGE),
  attachment: leaves('attachmentId', 'size', 'data'),
  thread: THREAD,
  threads: list('threads', THREAD),
  draft: DRAFT,
  drafts: list('drafts', DRAFT),
  filter: FILTER,
  filters: { filter: FILTER } as Shape,
  sendAs: { sendAs: SEND_AS } as Shape,
};
