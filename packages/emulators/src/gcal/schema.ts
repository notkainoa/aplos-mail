import type { Shape } from '../gmail/schema';

/** Field names of the Calendar v3 response types, for `fields=` validation (see the Gmail schema for the rules). */
const leaves = (...names: string[]): Shape => Object.fromEntries(names.map(name => [name, true]));

const WHEN = leaves('date', 'dateTime', 'timeZone');
const PERSON = leaves('id', 'email', 'displayName', 'self');
const ATTENDEE = leaves(
  'id',
  'email',
  'displayName',
  'organizer',
  'self',
  'resource',
  'optional',
  'responseStatus',
  'comment',
  'additionalGuests',
);
const REMINDER = leaves('method', 'minutes');

export const EVENT: Shape = {
  ...leaves(
    'kind',
    'etag',
    'id',
    'status',
    'htmlLink',
    'created',
    'updated',
    'summary',
    'description',
    'location',
    'colorId',
    'endTimeUnspecified',
    'recurrence',
    'recurringEventId',
    'transparency',
    'visibility',
    'iCalUID',
    'sequence',
    'attendeesOmitted',
    'guestsCanInviteOthers',
    'guestsCanModify',
    'guestsCanSeeOtherGuests',
    'privateCopy',
    'locked',
    'hangoutLink',
    'anyoneCanAddSelf',
    'eventType',
  ),
  creator: PERSON,
  organizer: PERSON,
  start: WHEN,
  end: WHEN,
  originalStartTime: WHEN,
  attendees: ATTENDEE,
  reminders: { useDefault: true, overrides: REMINDER },
  conferenceData: {
    ...leaves('conferenceId', 'signature', 'notes'),
    createRequest: {
      requestId: true,
      conferenceSolutionKey: leaves('type'),
      status: leaves('statusCode'),
    },
    entryPoints: leaves(
      'entryPointType',
      'uri',
      'label',
      'pin',
      'accessCode',
      'meetingCode',
      'passcode',
      'password',
    ),
    conferenceSolution: { key: leaves('type'), name: true, iconUri: true },
  },
  extendedProperties: leaves('private', 'shared'),
  attachments: leaves('fileUrl', 'title', 'mimeType', 'iconLink', 'fileId'),
  source: leaves('url', 'title'),
  gadget: leaves('type', 'title', 'link', 'iconLink', 'width', 'height', 'display', 'preferences'),
};

const ENTRY: Shape = {
  ...leaves(
    'kind',
    'etag',
    'id',
    'summary',
    'description',
    'location',
    'timeZone',
    'summaryOverride',
    'colorId',
    'backgroundColor',
    'foregroundColor',
    'hidden',
    'selected',
    'accessRole',
    'primary',
    'deleted',
  ),
  defaultReminders: REMINDER,
  conferenceProperties: leaves('allowedConferenceSolutionTypes'),
  notificationSettings: { notifications: leaves('type', 'method') },
};

export const CALENDAR_RESPONSE = {
  entry: ENTRY,
  list: { ...leaves('kind', 'etag', 'nextPageToken', 'nextSyncToken'), items: ENTRY } as Shape,
  event: EVENT,
  events: {
    ...leaves(
      'kind',
      'etag',
      'summary',
      'description',
      'updated',
      'timeZone',
      'accessRole',
      'nextPageToken',
      'nextSyncToken',
    ),
    defaultReminders: REMINDER,
    items: EVENT,
  } as Shape,
};
