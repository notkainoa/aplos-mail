// A local update feed for exercising the updater in development (see dev-app-update.yml and RELEASING.md).
// Serves latest-mac.yml announcing --version (default 0.2.0) and the ZIP it points at.
// Usage: node scripts/fake-update-feed.mjs [--version 0.2.0] [--zip release/Aplos-Mail-0.1.0-arm64.zip] [--port 4329]
// Without a ZIP (none given, none in release/), the feed still announces the version and the download fails,
// which exercises the error path.
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const version = arg('version', '0.2.0');
const port = Number(arg('port', '4329'));
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const found = existsSync('release')
  ? readdirSync('release')
      .filter(name => name.endsWith(`-${arch}.zip`))
      .sort()
      .at(-1)
  : undefined;
const zip = arg('zip', found ? join('release', found) : undefined);
const name = zip ? basename(zip) : `Aplos-Mail-${version}-${arch}.zip`;
const sha512 = zip ? createHash('sha512').update(readFileSync(zip)).digest('base64') : 'missing';
const size = zip ? statSync(zip).size : 0;
const feed = `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`;

createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname.slice(1));
  console.log(`${req.method} /${path}`);
  if (path === 'latest-mac.yml') {
    res.writeHead(200, { 'Content-Type': 'text/yaml' });
    res.end(feed);
    return;
  }
  if (zip && path === name) {
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Length': size });
    createReadStream(zip).pipe(res);
    return;
  }
  res.writeHead(404);
  res.end('Not found');
}).listen(port, '127.0.0.1', () => {
  console.log(
    `Fake update feed for ${version} on http://127.0.0.1:${port}/ (${zip ? `serving ${zip}` : 'no ZIP: downloads will fail'})`,
  );
  console.log('Run the app with: APLOS_UPDATE_DEV=1 npm run desktop');
});
