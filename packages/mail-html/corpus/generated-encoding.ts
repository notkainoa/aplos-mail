import { lead, seededRandom, tail, type Draft } from './generated-support';

// Malformed text at the string level the sanitizer receives: lone surrogates, control characters, replacement
// characters, byte order marks, numeric entity extremes and every kind of line break.

const HIGH = '\uD800';
const LOW = '\uDC00';
const LONE_SURROGATES = [
  '\uD800',
  '\uDBFF',
  '\uDC00',
  '\uDFFF',
  '\uDC00\uD800',
  '\uD800\uD800',
  '\uDFFF\uDBFF',
];

function hex(code: number): string {
  return code.toString(16).padStart(2, '0');
}

function loneSurrogates(): Draft {
  const rows = LONE_SURROGATES.map(
    (s, i) =>
      `<p>text${s}end</p><img src="{{CANARY}}/{{ID}}/text-${i}${s}" alt="${s}"><a href="jav${s}ascript:fetch('{{CANARY}}/{{ID}}/scheme-${i}')">link${s}</a>` +
      `<im${s}g src="{{CANARY}}/{{ID}}/tag-${i}"><img src="{{CANARY}}/{{ID}}/attr-${i}" on${s}error="fetch('{{CANARY}}/{{ID}}/handler-${i}')">` +
      `<style>.s${i}{background:url({{CANARY}}/{{ID}}/css-${i}${s})}</style>`,
  );
  return {
    id: 'g28-encoding-lone-surrogates',
    title: 'Half of a character pair in text, tags, attributes, addresses and style',
    classes: ['malformed-encoding', 'mxss'],
    html: `${lead('lone surrogate characters')}${rows.join('')}<p>${HIGH}${LOW} valid pair, ${HIGH} alone ${LOW} alone</p>${tail()}`,
    expect: { mustKeepText: ['lone surrogate characters'] },
    promise: { occurrences: [{ needle: HIGH, count: 5 }] },
  };
}

function controlCharacters(): Draft {
  const codes = [
    ...Array.from({ length: 0x20 }, (_, i) => i),
    ...Array.from({ length: 0x21 }, (_, i) => 0x7f + i),
  ];
  const rows = codes.map(code => {
    const c = String.fromCharCode(code);
    const h = hex(code);
    return (
      `<img${c}src="{{CANARY}}/{{ID}}/separator-${h}">` +
      `<a href="${c}javascript:fetch('{{CANARY}}/{{ID}}/leading-${h}')">l</a>` +
      `<a href="java${c}script:fetch('{{CANARY}}/{{ID}}/inside-${h}')">i</a>` +
      `<img src="{{CANARY}}/{{ID}}/value-${h}${c}x" on${c}error="fetch('{{CANARY}}/{{ID}}/name-${h}')">` +
      `<style>.c${h}{back${c}ground:ur${c}l({{CANARY}}/{{ID}}/css-${h})}</style>`
    );
  });
  return {
    id: 'g29-encoding-control-characters-all',
    title: 'Every control character in tags, attribute names, addresses and style',
    classes: ['malformed-encoding', 'mxss', 'javascript-url'],
    html: `${lead('control characters everywhere')}${rows.join('\n')}${tail()}`,
    expect: { mustKeepText: ['control characters everywhere'] },
    promise: { occurrences: [{ needle: '<img', count: 129 }] },
  };
}

function replacementAndBoms(): Draft {
  const noncharacters = ['\uFFFE', '\uFFFF', '\uFDD0', '\uFDEF', '\u{1FFFE}', '\u{10FFFF}'].join(
    ' ',
  );
  return {
    id: 'g30-encoding-replacement-bom-astral',
    title: 'Replacement characters, byte order marks, noncharacters and astral planes',
    classes: ['malformed-encoding', 'unicode-bidi'],
    html:
      '\uFEFF' +
      `${lead('replacement characters and marks')}<p>${'\uFFFD'.repeat(50_000)}</p><p>${noncharacters}</p>` +
      `<p>\uFEFF mid-document \uFEFF</p><\uFEFFimg src="{{CANARY}}/{{ID}}/bom-in-tag"><img\uFEFFsrc="{{CANARY}}/{{ID}}/bom-separator">` +
      `<img src="{{CANARY}}/{{ID}}/astral-attr" \u{1F600}="x" data-\u{1D400}="y"><\u{1F600}img src="{{CANARY}}/{{ID}}/astral-tag">` +
      `<p>${'\u0301'.repeat(100_000)}</p><p>${'\u202E'.repeat(10_000)}</p><p>${'\u200B'.repeat(100_000)}</p>${tail()}`,
    expect: { mustKeepText: ['replacement characters and marks'] },
    promise: { minChars: 250_000, occurrences: [{ needle: '\uFFFD', count: 50_000 }] },
  };
}

function overlongEntities(): Draft {
  const forms = [
    '&#x0000;',
    '&#0;',
    '&#x00000000000000000000;',
    '&#xD800;',
    '&#xDFFF;',
    '&#55296;',
    '&#1114112;',
    '&#x110000;',
    '&#99999999999999999999;',
    '&#x7FFFFFFFFFFFFFFF;',
    '&#-1;',
    '&#x-1;',
    '&#65',
    '&#x41',
    '&#X41;',
    '&#x;',
    '&#;',
    '&#',
    '&amp',
    '&ampx',
    '&AMP;',
    '&notit;',
    '&NotNestedGreaterGreater;',
    '&lt',
    '&#128;',
    '&#x9F;',
    '&#13;',
    '&#12;',
  ];
  const row = forms.map(f => `<p>${f}</p><a href="x${f}y">${f}</a>`).join('');
  const long = `&#${'0'.repeat(100_000)}65;`;
  const hexLong = `&#x${'0'.repeat(100_000)}41;`;
  return {
    id: 'g31-encoding-overlong-entities',
    title:
      'Character references at and beyond their limits, and ones with a hundred thousand zeros',
    classes: ['malformed-encoding', 'resource-exhaustion'],
    html: `${lead('character reference extremes')}${row}<p>${long}</p><p>${hexLong}</p><p>${'&amp'.repeat(100_000)}</p><p>${'&a'.repeat(100_000)}</p><a href="&#${'0'.repeat(1000)}106avascript:fetch('{{CANARY}}/{{ID}}/zero-padded-scheme')">padded scheme</a>${tail()}`,
    expect: { mustKeepText: ['character reference extremes'] },
    promise: { minChars: 700_000, occurrences: [{ needle: '&#x0000;', count: 1 }] },
  };
}

function mixedLineEndings(): Draft {
  const random = seededRandom(31);
  const breaks = ['\r\n', '\r', '\n', '\u2028', '\u2029', '\u0085', '\n\r'];
  const pick = () => breaks[Math.floor(random() * breaks.length)];
  const rows: string[] = [];
  for (let i = 0; i < 20_000; i += 1) {
    rows.push(`<p${pick()}class="r${i}"${pick()}>line ${i}</p>${pick()}`);
  }
  rows.push(
    `<img${pick()}src="{{CANARY}}/{{ID}}/break-in-tag"${pick()}alt="">`,
    `<a href="java${pick()}script:fetch('{{CANARY}}/{{ID}}/break-in-scheme')">x</a>`,
  );
  return {
    id: 'g32-encoding-mixed-line-endings',
    title: 'Twenty thousand lines using every kind of line break, including inside tags',
    classes: ['malformed-encoding', 'mxss'],
    html: `${lead('mixed line endings')}${rows.join('')}${tail()}`,
    expect: { mustKeepText: ['mixed line endings'] },
    promise: {
      minChars: 300_000,
      occurrences: [
        { needle: '\r\n', count: 100 },
        { needle: '\r', count: 100 },
      ],
    },
  };
}

function mojibake(): Draft {
  return {
    id: 'g33-encoding-mojibake-and-escapes',
    title: 'Text that was decoded with the wrong character set',
    classes: ['malformed-encoding', 'meta-misc'],
    html: `${lead('mojibake text')}<p>Caf\u00C3\u00A9 cr\u00C3\u00A8me, don\u00E2\u20AC\u2122t, \u00E2\u20AC\u0153quoted\u00E2\u20AC\u009d, \u00D0\u0178\u00D1\u20AC\u00D0\u00B8\u00D0\u00B2\u00D0\u00B5\u00D1\u201A, \u00E5\u00A0\u00A0\u00E5\u00A5\u00BD, \u00C2\u00A35, \u00C3\u0083\u00C2\u00A9</p><p>%E2%80%AE percent-escaped override, =E2=80=AE quoted-printable override, =3Cscript=3E quoted-printable markup, \\u202e \\x3cscript\\x3e escapes</p><p>+ADw-script+AD4- utf-7 markup, \u001b$B\u001b(B iso-2022-jp shift</p>${tail()}`,
    expect: { mustKeepText: ['mojibake text'] },
    promise: { minChars: 200 },
  };
}

function nulsEverywhere(): Draft {
  return {
    id: 'g34-encoding-nul-runs',
    title: 'Runs of NUL characters in the middle of markup',
    classes: ['malformed-encoding', 'resource-exhaustion'],
    html: `${lead('nul runs')}<p>${'\u0000'.repeat(100_000)}</p><scr${'\u0000'.repeat(1000)}ipt>fetch('{{CANARY}}/{{ID}}/nul-run-script')</scr${'\u0000'.repeat(1000)}ipt><img${'\u0000'.repeat(1000)}src="{{CANARY}}/{{ID}}/nul-run-img"><!--${'\u0000'.repeat(1000)}--><style>${'\u0000'.repeat(1000)}</style>${tail()}`,
    expect: { mustKeepText: ['nul runs'] },
    promise: { minChars: 100_000, occurrences: [{ needle: '\u0000', count: 100_000 }] },
  };
}

export function encodingEntries(): Draft[] {
  return [
    loneSurrogates(),
    controlCharacters(),
    replacementAndBoms(),
    overlongEntities(),
    mixedLineEndings(),
    mojibake(),
    nulsEverywhere(),
  ];
}
