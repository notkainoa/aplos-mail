// Exports PNGs of the Icon Composer icon (assets/AppIcon.icon) for the places that cannot use it directly.
// The packaged app compiles AppIcon.icon itself (package.json mac.icon), so run this only after editing the icon.
//   assets/icon.png     1024 px on the macOS icon grid (with margin): dev Dock icon, window icon, README
//   assets/icon-256.png 256 px, the icon edge to edge: in-app (welcome, loading, About)
//   assets/icon-64.png  64 px, edge to edge: website logo and favicon
//   assets/trayTemplate.png, trayTemplate@2x.png  18 and 36 px black envelope outline from assets/tray.svg: the menu-bar item
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'darwin')
  throw new Error('Exporting the icon needs macOS with Xcode 26 or later (Icon Composer).');
const developer = execFileSync('/usr/bin/xcode-select', ['-p'], { encoding: 'utf8' }).trim();
const ictool = join(
  developer,
  '..',
  'Applications',
  'Icon Composer.app',
  'Contents',
  'Executables',
  'ictool',
);
const source = resolve('assets/AppIcon.icon');
const temporary = await mkdtemp(join(tmpdir(), 'aplos-icon-'));
const exportImage = (size, output) =>
  execFileSync(
    ictool,
    [
      source,
      '--export-image',
      '--output-file',
      output,
      '--platform',
      'macOS',
      '--rendition',
      'Default',
      '--width',
      String(size),
      '--height',
      String(size),
      '--scale',
      '1',
    ],
    { stdio: 'ignore' },
  );
const sips = (...args) => execFileSync('/usr/bin/sips', args, { stdio: 'ignore' });
try {
  // macOS icons are 824 px inside a 1024 px canvas.
  const grid = join(temporary, 'grid.png');
  exportImage(824, grid);
  sips('--padToHeightWidth', '1024', '1024', grid, '--out', resolve('assets/icon.png'));
  const full = join(temporary, 'full.png');
  exportImage(1024, full);
  sips('-z', '256', '256', full, '--out', resolve('assets/icon-256.png'));
  sips('-z', '64', '64', full, '--out', resolve('assets/icon-64.png'));
  // The tray glyph is a template image: black on transparent, which macOS tints for light, dark and selected states.
  const trayArt = await readFile(resolve('assets/tray.svg'), 'utf8');
  for (const [px, name] of [
    [18, 'trayTemplate.png'],
    [36, 'trayTemplate@2x.png'],
  ]) {
    const svg = join(temporary, `tray-${px}.svg`);
    await writeFile(svg, trayArt.replace('width="36" height="36"', `width="${px}" height="${px}"`));
    sips('-s', 'format', 'png', svg, '--out', resolve('assets', name));
  }
  console.log(
    'Wrote assets/icon.png, icon-256.png, icon-64.png and the trayTemplate images from assets/AppIcon.icon and tray.svg.',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
