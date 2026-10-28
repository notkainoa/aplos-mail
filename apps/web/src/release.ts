// What the download page offers. There is no public release yet: the repository is private and builds are shared with
// invited testers directly, so `release` is null and the page says so. Once the repository is public, `release` is
// filled from its published GitHub release at build time (see VISION.md), and a production build must never ship
// sample data. Aplos Mail is built for macOS only, for Apple silicon and Intel.
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
