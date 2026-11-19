// What the download page offers, and the one switch for the site's "coming soon" state (`release` null). It holds
// the published 0.0.1 release (2026-11-19); update it from each new published release (see VISION.md). A
// production build must never ship sample data.
// Aplos Mail is built for macOS only, for Apple silicon and Intel.
export type Target = 'mac-arm64' | 'mac-x64';
export type File = {
  target: Target;
  label: string; // "Apple silicon" or "Intel"
  name: string;
  size: number; // bytes
  url: string;
};
export type Release = { version: string; date: string; notesUrl: string; files: File[] };

export const requires = 'macOS 13 or later, on a Mac with Apple silicon or Intel.';
// Where the release files are hosted: the repository's own release downloads.
const host = 'https://github.com/notkainoa/aplos-mail/releases'; // claims-allow: github

export const release: Release | null = {
  version: '0.0.1',
  date: '2026-11-19',
  notesUrl: `${host}/tag/v0.0.1`,
  files: [
    {
      target: 'mac-arm64',
      label: 'Apple silicon',
      name: 'Aplos-Mail-0.0.1-arm64.dmg',
      size: 145578162,
      url: `${host}/download/v0.0.1/Aplos-Mail-0.0.1-arm64.dmg`,
    },
    {
      target: 'mac-x64',
      label: 'Intel',
      name: 'Aplos-Mail-0.0.1-x64.dmg',
      size: 152205625,
      url: `${host}/download/v0.0.1/Aplos-Mail-0.0.1-x64.dmg`,
    },
  ],
};

export const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
