/**
 * Which icon an attachment chip wears (DESIGN 7.5): the file's kind from its MIME type, else its extension. A PDF or
 * text document is `file-text`, a picture `file-image`, an archive `file-archive`, a spreadsheet `file-sheet`, a
 * calendar invitation `calendar`; anything else is the plain `file`.
 */
import type { IconName } from '../../ui/props';

/** The icons an attachment can wear. */
export type AttachmentIcon =
  'file-text' | 'file-image' | 'file-archive' | 'file-sheet' | 'calendar' | 'file';

const BY_EXTENSION: Readonly<Record<string, AttachmentIcon>> = {
  pdf: 'file-text',
  txt: 'file-text',
  md: 'file-text',
  rtf: 'file-text',
  doc: 'file-text',
  docx: 'file-text',
  odt: 'file-text',
  pages: 'file-text',
  png: 'file-image',
  jpg: 'file-image',
  jpeg: 'file-image',
  gif: 'file-image',
  webp: 'file-image',
  heic: 'file-image',
  svg: 'file-image',
  tif: 'file-image',
  tiff: 'file-image',
  zip: 'file-archive',
  gz: 'file-archive',
  tgz: 'file-archive',
  rar: 'file-archive',
  '7z': 'file-archive',
  tar: 'file-archive',
  xls: 'file-sheet',
  xlsx: 'file-sheet',
  csv: 'file-sheet',
  tsv: 'file-sheet',
  ods: 'file-sheet',
  numbers: 'file-sheet',
  ics: 'calendar',
  ical: 'calendar',
  vcs: 'calendar',
};

const ARCHIVE_MIME = /(?:zip|x-tar|gzip|x-7z|x-rar|compressed)/;
const SHEET_MIME = /(?:spreadsheet|ms-excel|text\/csv|tab-separated)/;
const TEXT_MIME =
  /^(?:application\/pdf|text\/plain|text\/markdown|application\/rtf)|wordprocessing|msword/;

function iconOfMime(mime: string): AttachmentIcon | null {
  const type = mime.trim().toLowerCase();
  if (type === '' || type === 'application/octet-stream') return null;
  if (type.startsWith('image/')) return 'file-image';
  if (type === 'text/calendar' || type === 'application/ics') return 'calendar';
  if (SHEET_MIME.test(type)) return 'file-sheet';
  if (ARCHIVE_MIME.test(type)) return 'file-archive';
  if (TEXT_MIME.test(type)) return 'file-text';
  return null;
}

function iconOfName(name: string): AttachmentIcon | null {
  const dot = name.lastIndexOf('.');
  if (dot < 0 || dot === name.length - 1) return null;
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

/** The chip's icon for a file: its MIME type first, its name's extension next, else the plain file. */
export function attachmentIcon(name: string, mime: string): AttachmentIcon & IconName {
  return iconOfMime(mime) ?? iconOfName(name) ?? 'file';
}
