import { repoUrl } from './site';

// What the download page offers. This is SAMPLE DATA until the first public release: the version, dates, sizes and the
// Windows and Linux builds are made up so the page can be designed. While `sample` is true the page never starts a
// download by itself. See VISION.md for how this should come from GitHub Releases instead.
export type Target =
  'mac-arm64' | 'mac-x64' | 'win-x64' | 'win-arm64' | 'linux-x64' | 'linux-arm64';
export type Os = 'mac' | 'win' | 'linux';
export type File = {
  target: Target;
  label: string;
  kind: string;
  name: string;
  size: number;
  url: string;
};
export type Platform = { os: Os; name: string; requires: string; files: File[] };

const version = '0.1.0';
const file = (target: Target, label: string, name: string, size: number): File => ({
  target,
  label,
  kind: name.slice(name.lastIndexOf('.')),
  name,
  size,
  url: `${repoUrl}/releases/download/v${version}/${name}`,
});

export const release = {
  sample: true,
  version,
  date: '2026-10-24',
  notesUrl: `${repoUrl}/releases/tag/v${version}`,
  allUrl: `${repoUrl}/releases`,
  platforms: [
    {
      os: 'mac',
      name: 'macOS',
      requires: 'For macOS 12 Monterey and newer. Updates install themselves.',
      files: [
        file('mac-arm64', 'Apple silicon', `Aplos-Mail-${version}-arm64.dmg`, 148_300_000),
        file('mac-x64', 'Intel', `Aplos-Mail-${version}-x64.dmg`, 156_900_000),
      ],
    },
    {
      os: 'win',
      name: 'Windows',
      requires: 'For Windows 10 and newer. Updates install themselves.',
      files: [
        file('win-x64', '64-bit', `Aplos-Mail-Setup-${version}-x64.exe`, 121_400_000),
        file('win-arm64', 'Arm', `Aplos-Mail-Setup-${version}-arm64.exe`, 118_200_000),
      ],
    },
    {
      os: 'linux',
      name: 'Linux',
      requires: 'An AppImage that runs on most distributions.',
      files: [
        file('linux-x64', '64-bit', `Aplos-Mail-${version}-x86_64.AppImage`, 139_700_000),
        file('linux-arm64', 'Arm', `Aplos-Mail-${version}-arm64.AppImage`, 136_100_000),
      ],
    },
  ] satisfies Platform[],
};

export type Offer = File & { platform: Platform };
const offers: Offer[] = release.platforms.flatMap(p => p.files.map(f => ({ ...f, platform: p })));
export const findFile = (target: Target) => offers.find(f => f.target === target)!;
export const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;
