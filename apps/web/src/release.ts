// What the download page offers, and the one switch for the site's "coming soon" state. There is no published
// release yet (every release in the repository is a draft; the first public one will be 0.0.1), so `release` is
// null: the landing page and the download page say the Mac download is coming soon and link to no file. Once a
// release is published, fill `release` from it (see VISION.md); a production build must never ship sample data.
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
export const release: Release | null = null;

export const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
