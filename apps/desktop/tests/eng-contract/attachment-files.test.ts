import assert from 'node:assert/strict';
import test from 'node:test';
import { parseArgs } from '@aplos/contract';
import {
  isOpenable,
  MAX_FILE_BYTES,
  openAttachment,
  saveAttachment,
  sweepTemp,
  TEMP_PREFIX,
  type FileIo,
} from '../../src/shared/attachment-files';
import { guardedDesktopCall, DESKTOP_FAILURE_KEY } from '../../src/shared/desktop-error';
import { fileNameOf } from '../../src/shared/desktop-v1';
import { sniffMatches, SNIFFED_EXTENSIONS } from '../../src/shared/file-sniff';
import { markQuarantined, quarantineValue } from '../../src/shared/quarantine';

const bytes = (...values: number[]) => Uint8Array.from(values);
const ascii = (text: string) => Uint8Array.from([...text].map(c => c.charCodeAt(0)));
const PDF = ascii('%PDF-1.7\n');

/** A fake disk and OS that records every call in order. */
function fakeIo(
  options: {
    openError?: string;
    quarantineFails?: boolean;
    canceled?: boolean;
    testMode?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const written: Array<{ path: string; mode?: number }> = [];
  const io: FileIo = {
    chooseSavePath: async name => {
      calls.push(`dialog:${name}`);
      return options.canceled
        ? { canceled: true }
        : { canceled: false, filePath: '/Users/o/Chosen.pdf' };
    },
    writeFile: async (path, _data, o) => {
      calls.push(`write:${path}`);
      written.push({ path, ...(o ? { mode: o.mode } : {}) });
    },
    makeTempDir: async prefix => (calls.push(`mkdtemp:${prefix}`), '/tmp/aplos-attachment-AbC'),
    join: (...parts) => parts.join('/'),
    openPath: async path => (calls.push(`open:${path}`), options.openError ?? ''),
    quarantine: async path => {
      calls.push(`quarantine:${path}`);
      if (options.quarantineFails) throw new Error('no xattr');
    },
    removeDir: async path => void calls.push(`rm:${path}`),
    testMode: options.testMode ?? false,
  };
  return { io, calls, written };
}

test('fileNameOf drops format characters and DEL, leading dots and trailing dots and spaces', () => {
  assert.equal(fileNameOf('invoice\u202Efdp.exe'), 'invoicefdp.exe', 'right-to-left override');
  assert.equal(fileNameOf('x\u2066.pdf'), 'x.pdf', 'bidi isolate');
  assert.equal(
    fileNameOf('\u202E.txt'),
    'txt',
    'an override then a dot: the dot goes, so it is no longer an extension',
  );
  assert.equal(fileNameOf('a\u200Bb\uFEFF.pdf'), 'ab.pdf', 'zero-width space and BOM');
  assert.equal(fileNameOf('a\u007Fb.pdf'), 'ab.pdf', 'DEL');
  assert.equal(fileNameOf('...hidden.txt'), 'hidden.txt');
  assert.equal(fileNameOf('report.pdf. . '), 'report.pdf');
  assert.equal(fileNameOf('. . .'), 'attachment');
});

test('the quarantine attribute is written with an argument array: a hostile name is one element, never a command', async () => {
  assert.equal(quarantineValue(1_700_000_000_000), '0083;6553f100;Aplos Mail;');
  const runs: Array<{ tool: string; args: readonly string[] }> = [];
  const run = async (tool: string, args: readonly string[]) => void runs.push({ tool, args });
  const hostile = '/tmp/a b; rm -rf ~ $(x).pdf';
  await markQuarantined(hostile, { now: () => 1_700_000_000_000, platform: 'darwin', run });
  assert.deepEqual(runs, [
    {
      tool: '/usr/bin/xattr',
      args: ['-w', 'com.apple.quarantine', '0083;6553f100;Aplos Mail;', hostile],
    },
  ]);
  await markQuarantined(hostile, { platform: 'linux', run });
  assert.equal(runs.length, 1, 'no such attribute off macOS');
  await assert.rejects(
    markQuarantined('/x', {
      platform: 'darwin',
      run: async () => Promise.reject(new Error('xattr failed')),
    }),
  );
});

test('sniffing: each safe type needs its own first bytes; a renamed program is refused', () => {
  const ok: Array<[string, Uint8Array]> = [
    ['.pdf', PDF],
    ['.png', bytes(0x89, 0x50, 0x4e, 0x47, 0x0d)],
    ['.jpg', bytes(0xff, 0xd8, 0xff, 0xe0)],
    ['.gif', ascii('GIF89a')],
    ['.webp', ascii('RIFF\0\0\0\0WEBPVP8 ')],
    ['.docx', bytes(0x50, 0x4b, 0x03, 0x04, 0)],
    ['.mp4', ascii('\0\0\0\x18ftypmp42')],
    ['.mp3', ascii('ID3\x03')],
    ['.wav', ascii('RIFF\0\0\0\0WAVEfmt ')],
    ['.rtf', ascii('{\\rtf1\\ansi')],
    ['.txt', ascii('hello\n')],
    ['.ics', ascii('BEGIN:VCALENDAR\r\n')],
  ];
  for (const [extension, data] of ok) assert.ok(sniffMatches(extension, data), extension);
  const mach = bytes(0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0);
  for (const extension of SNIFFED_EXTENSIONS)
    if (!['.txt', '.md', '.csv', '.json', '.eml', '.ics'].includes(extension))
      assert.ok(!sniffMatches(extension, mach), `${extension} refuses a Mach-O program`);
  assert.ok(!sniffMatches('.txt', bytes(0x4d, 0x5a, 0, 0)), 'text with a NUL byte is not text');
  assert.ok(!sniffMatches('.doc', PDF) && !sniffMatches('', PDF), 'no sniffer, no open');
  assert.ok(
    !SNIFFED_EXTENSIONS.has('.doc') &&
      !SNIFFED_EXTENSIONS.has('.xls') &&
      !SNIFFED_EXTENSIONS.has('.ppt'),
  );
});

test('openAttachment refuses a program, a double extension, no extension and a type/bytes mismatch BEFORE writing anything', async () => {
  for (const [name, data] of [
    ['Tool.app', PDF],
    ['Report.pdf.app', PDF],
    ['run.command', PDF],
    ['x.terminal', PDF],
    ['link.webloc', PDF],
    ['page.html', PDF],
    ['noextension', PDF],
    ['legacy.doc', PDF],
    ['Report.pdf', bytes(0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0)],
    ['photo.png', PDF],
  ] as Array<[string, Uint8Array]>) {
    const { io, calls } = fakeIo();
    await assert.rejects(
      openAttachment(io, name, data),
      /Save this attachment to inspect it before opening\./,
      name,
    );
    assert.deepEqual(calls, [], `${name}: nothing was written or opened`);
  }
  assert.ok(isOpenable('Report.PDF', PDF));
});

test('openAttachment writes a private temp file, quarantines it, then opens it, in that order', async () => {
  const { io, calls, written } = fakeIo();
  assert.equal(await openAttachment(io, 'Report.pdf', PDF), true);
  assert.deepEqual(calls, [
    `mkdtemp:${TEMP_PREFIX}`,
    'write:/tmp/aplos-attachment-AbC/Report.pdf',
    'quarantine:/tmp/aplos-attachment-AbC/Report.pdf',
    'open:/tmp/aplos-attachment-AbC/Report.pdf',
  ]);
  assert.equal(written[0]!.mode, 0o600);
});

test('openAttachment fails closed: no quarantine, no open; an OS error is the plain sentence; test mode launches nothing', async () => {
  const noMark = fakeIo({ quarantineFails: true });
  await assert.rejects(openAttachment(noMark.io, 'Report.pdf', PDF), /couldn't open that file/);
  assert.ok(
    !noMark.calls.some(call => call.startsWith('open:')),
    'never handed to an app unmarked',
  );
  assert.ok(
    noMark.calls.includes('rm:/tmp/aplos-attachment-AbC'),
    'and nothing unmarked stays on disk',
  );
  const osError = fakeIo({ openError: "No application knows how to open '/private/var/x'" });
  await assert.rejects(openAttachment(osError.io, 'Report.pdf', PDF), (error: Error) => {
    assert.match(error.message, /couldn't open that file/);
    assert.doesNotMatch(error.message, /private|var/);
    return true;
  });
  const quiet = fakeIo({ testMode: true });
  assert.equal(await openAttachment(quiet.io, 'Report.pdf', PDF), true);
  assert.deepEqual(quiet.calls, []);
  await assert.rejects(
    openAttachment(fakeIo().io, 'big.pdf', new Uint8Array(MAX_FILE_BYTES + 1)),
    /25 MB/,
  );
});

test('saveAttachment writes only to the path the save dialog returned; a renderer-supplied path has nowhere to go', async () => {
  // The contract strips what the schema does not name, and the function has no place to take a path.
  const parsed = parseArgs('File/save', {
    blobId: 'b1',
    name: 'a.pdf',
    path: '/etc/cron.d/x',
    filePath: '/etc/x',
  });
  assert.deepEqual(parsed, { blobId: 'b1', name: 'a.pdf' });
  assert.equal(saveAttachment.length, 3, '(io, name, data): no path parameter');
  const { io, calls } = fakeIo();
  assert.deepEqual(await saveAttachment(io, 'a.pdf', PDF), {
    canceled: false,
    path: '/Users/o/Chosen.pdf',
  });
  assert.deepEqual(calls, [
    'dialog:a.pdf',
    'write:/Users/o/Chosen.pdf',
    'quarantine:/Users/o/Chosen.pdf',
  ]);
  const cancelled = fakeIo({ canceled: true });
  assert.deepEqual(await saveAttachment(cancelled.io, 'a.pdf', PDF), { canceled: true });
  assert.deepEqual(cancelled.calls, ['dialog:a.pdf']);
  const noXattr = fakeIo({ quarantineFails: true });
  assert.equal(
    (await saveAttachment(noXattr.io, 'a.pdf', PDF)).canceled,
    false,
    'a save is not lost to a missing xattr',
  );
});

test("the start-up sweep removes only this app's attachment folders and survives a failure", async () => {
  const removed: string[] = [];
  const count = await sweepTemp({
    tempEntries: async () => [`${TEMP_PREFIX}one`, 'com.apple.x', `${TEMP_PREFIX}two`, 'notes.txt'],
    removeTemp: async entry => {
      if (entry.endsWith('two')) throw new Error('busy');
      removed.push(entry);
    },
  });
  assert.deepEqual(removed, [`${TEMP_PREFIX}one`]);
  assert.equal(count, 1);
  assert.equal(
    await sweepTemp({
      tempEntries: () => Promise.reject(new Error('x')),
      removeTemp: async () => undefined,
    }),
    0,
  );
});

test('guardedDesktopCall: the caller check runs first and alone; a failure after it is an envelope', async () => {
  let ran = 0;
  await assert.rejects(
    guardedDesktopCall(
      () => {
        throw new Error('Untrusted application window.');
      },
      async () => void (ran += 1),
    ),
    /Untrusted/,
  );
  assert.equal(ran, 0, 'the handler never ran for an untrusted caller');
  const failure = (await guardedDesktopCall(
    () => undefined,
    async () => Promise.reject(new Error('No.')),
  )) as Record<string, unknown>;
  assert.ok(DESKTOP_FAILURE_KEY in failure);
  assert.deepEqual(
    await guardedDesktopCall(
      () => undefined,
      async () => ({ ok: true }),
    ),
    { ok: true },
  );
});

test('sniffing: real-world variants open (UTF-16 text, a PDF with a leading byte-order mark, a QuickTime picture atom) and look-alikes do not', () => {
  const utf16 = Uint8Array.from([
    0xff,
    0xfe,
    ...[...'Name,Amount\n'].flatMap(c => [c.charCodeAt(0), 0]),
  ]);
  assert.ok(sniffMatches('.txt', utf16), 'UTF-16LE with a byte order mark');
  assert.ok(
    !sniffMatches('.txt', Uint8Array.from([0xff, 0xfe, 0, 0, 0x41, 0x00, 0x42, 0x00, 0, 0x43])),
    'NULs in both lanes are binary',
  );
  assert.ok(
    sniffMatches('.pdf', Uint8Array.from([0xef, 0xbb, 0xbf, ...ascii('\n%PDF-1.4')])),
    'a header after a BOM and a newline',
  );
  assert.ok(
    !sniffMatches('.pdf', Uint8Array.from([...new Uint8Array(1100), ...ascii('%PDF-1.4')])),
    'but not after 1 KB',
  );
  assert.ok(sniffMatches('.mov', ascii('\0\0\0\x14pnotabcd')));
});

test('fileNameOf also drops the C1 controls and the line and paragraph separators', () => {
  assert.equal(fileNameOf('a\u0085b\u009Fc\u2028d\u2029e.pdf'), 'abcde.pdf');
});
