import { fill, seededRandom, type Draft } from './generated-support';

// Large plain-text and many-attachment inputs: the text path and the cid list have their own limits.

const FIVE_MB = 5 * 1024 * 1024;

function longText(): Draft {
  return {
    id: 'g35-text-line-5mb',
    title: 'A plain text message that is one five megabyte line',
    classes: ['plain-text', 'huge-line', 'resource-exhaustion'],
    text: `Synthetic stress message: five megabyte text line. ${fill('word <script>fetch("{{CANARY}}/{{ID}}/text-line")</script> ', FIVE_MB)}`,
    expect: { bodyKind: 'text', mustKeepText: ['five megabyte text line'] },
    promise: { minChars: FIVE_MB, singleLine: true },
  };
}

function quotedText(): Draft {
  const random = seededRandom(5);
  const lines: string[] = ['Synthetic stress message: deeply quoted text.', ''];
  for (let i = 0; i < 100_000; i += 1) {
    const depth = 1 + Math.floor(random() * 40);
    lines.push(`${'> '.repeat(depth)}line ${i}`);
  }
  lines.push('', '<img src="{{CANARY}}/{{ID}}/quoted-text-end">');
  return {
    id: 'g36-text-quoted-100k-lines',
    title: 'A plain text reply with a hundred thousand quoted lines',
    classes: ['plain-text', 'quoted-history', 'resource-exhaustion'],
    text: lines.join('\n'),
    expect: { bodyKind: 'text', mustKeepText: ['deeply quoted text'], quotedCountMin: 1 },
    promise: { minChars: 500_000, occurrences: [{ needle: '\n> ', count: 90_000 }] },
  };
}

function manyCids(): Draft {
  const count = 5_000;
  const cids = Array.from({ length: count }, (_, i) => `part${i}@mail.example`);
  const images = cids.map(cid => `<img src="cid:${cid}" width="10" height="10" alt="">`).join('');
  return {
    id: 'g37-cids-5000',
    title: 'Five thousand inline attachments, each used once, plus unknown ones',
    classes: ['cid-inline', 'resource-exhaustion'],
    html: `<p>Synthetic stress message: many inline parts.</p>${images}<img src="cid:unknown@mail.example" alt=""><img src="{{CANARY}}/{{ID}}/after-cids" width="40" height="40" alt="end marker">`,
    cids,
    expect: { mustKeepText: ['many inline parts'] },
    promise: { occurrences: [{ needle: '<img src="cid:', count: count }] },
  };
}

function svgEntityBomb(): Draft {
  const entities = Array.from(
    { length: 9 },
    (_, i) => `<!ENTITY e${i + 1} "${`&e${i};`.repeat(10)}">`,
  ).join('');
  const doctype = `<!DOCTYPE svg [<!ENTITY e0 "lol">${entities}]>`;
  const svg = encodeURIComponent(
    `<?xml version="1.0"?>${doctype}<svg xmlns="http://www.w3.org/2000/svg"><text>&e9;</text></svg>`,
  );
  return {
    id: 'g38-entity-expansion-bombs',
    title: 'Entity expansion bombs in an SVG data image and in an XML wrapper',
    classes: ['resource-exhaustion', 'data-url', 'svg-other', 'mxss'],
    html: `<p>Synthetic stress message: entity expansion.</p><img src="data:image/svg+xml,${svg}" alt="bomb image"><object data="data:image/svg+xml,${svg}"></object><?xml version="1.0"?>${doctype}<p>&e9;</p><img src="{{CANARY}}/{{ID}}/after-bomb" width="40" height="40" alt="end marker">`,
    expect: { mustKeepText: ['entity expansion'] },
    promise: { minChars: 1_000 },
  };
}

export function textEntries(): Draft[] {
  return [longText(), quotedText(), manyCids(), svgEntityBomb()];
}
