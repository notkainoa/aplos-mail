import { fill, lead, seededRandom, tail, type Draft } from './generated-support';

// Huge single lines, huge and numerous attributes, and style and parser bombs.

const FIVE_MB = 5 * 1024 * 1024;

const WORDS = ['harbour', 'market', 'autumn', 'invoice', 'garden', 'letter', 'update', 'notice'];

function proseLine(chars: number): string {
  const random = seededRandom(7);
  const parts: string[] = [];
  let length = 0;
  while (length < chars) {
    const word = WORDS[Math.floor(random() * WORDS.length)];
    parts.push(word);
    length += word.length + 1;
  }
  return parts.join(' ');
}

function textLine(): Draft {
  return {
    id: 'g12-line-prose-5mb',
    title: 'Five megabytes of prose on a single line',
    classes: ['huge-line', 'find-text', 'resource-exhaustion'],
    html: `${lead('five megabyte prose line')}<p>${proseLine(FIVE_MB)}</p>${tail()}`,
    expect: { mustKeepText: ['five megabyte prose line'] },
    promise: { minChars: FIVE_MB, singleLine: true },
  };
}

function tagLine(): Draft {
  return {
    id: 'g13-line-tags-5mb',
    title: 'Five megabytes of small tags on a single line',
    classes: ['huge-line', 'resource-exhaustion'],
    html: `${lead('five megabyte tag line')}${fill('<span class="a">x</span>', FIVE_MB)}${tail()}`,
    expect: { mustKeepText: ['five megabyte tag line'] },
    promise: { minChars: FIVE_MB, singleLine: true },
  };
}

function styleLine(): Draft {
  const rules = fill('.c{color:#112233;margin:0}', FIVE_MB);
  return {
    id: 'g14-line-style-5mb',
    title: 'A five megabyte style block on one line',
    classes: ['huge-line', 'css-url', 'resource-exhaustion'],
    html: `<style>${rules}.last{background:url({{CANARY}}/{{ID}}/last-rule)}</style>${lead('five megabyte style line')}${tail()}`,
    expect: { mustKeepText: ['five megabyte style line'] },
    promise: { minChars: FIVE_MB, singleLine: true },
  };
}

function attributeLine(): Draft {
  return {
    id: 'g15-line-href-5mb',
    title: 'A link whose address is five megabytes long',
    classes: ['huge-line', 'resource-exhaustion'],
    html: `${lead('five megabyte address')}<a href="{{CANARY}}/{{ID}}/long/${'a'.repeat(FIVE_MB)}">a very long link</a>${tail()}`,
    expect: { mustKeepText: ['five megabyte address'] },
    promise: { minChars: FIVE_MB, singleLine: true },
  };
}

function commentLine(): Draft {
  return {
    id: 'g16-line-comment-5mb',
    title: 'A five megabyte comment, then an image',
    classes: ['huge-line', 'mxss', 'resource-exhaustion'],
    html: `${lead('five megabyte comment')}<!--${'x'.repeat(FIVE_MB)}-->${tail()}`,
    expect: { mustKeepText: ['five megabyte comment'] },
    promise: { minChars: FIVE_MB, singleLine: true },
  };
}

function unterminatedComment(): Draft {
  return {
    id: 'g17-line-comment-unterminated-5mb',
    title: 'A five megabyte comment that never ends, hiding an image from a loose parser',
    classes: ['huge-line', 'mxss', 'resource-exhaustion'],
    html: `${lead('unterminated comment')}<!--${'x'.repeat(FIVE_MB)}${tail('hidden-in-comment')}`,
    expect: { mustKeepText: ['unterminated comment'] },
    promise: { minChars: FIVE_MB, singleLine: true },
  };
}

function dataUriImage(): Draft {
  const body = 'A'.repeat(3 * 1024 * 1024);
  return {
    id: 'g18-line-data-image-3mb',
    title: 'A three megabyte inline data image',
    classes: ['huge-line', 'data-url', 'resource-exhaustion'],
    html: `${lead('large inline image')}<img src="data:image/png;base64,${body}" alt="large inline image">${tail()}`,
    expect: { mustKeepText: ['large inline image'] },
    promise: { minChars: 3 * 1024 * 1024, singleLine: true },
  };
}

function longImageUrl(): Draft {
  return {
    id: 'g19-line-image-url-5mb',
    title: 'An image address five megabytes long',
    classes: ['huge-line', 'remote-image', 'resource-exhaustion'],
    html: `${lead('five megabyte image address')}<img src="{{CANARY}}/{{ID}}/long/${'b'.repeat(FIVE_MB)}" width="40" height="40" alt="long address">${tail()}`,
    expect: { mustKeepText: ['five megabyte image address'] },
    promise: { minChars: FIVE_MB, singleLine: true },
  };
}

function attributesDistinct(): Draft {
  const names = Array.from({ length: 10_000 }, (_, i) => `a${i}="v${i}"`).join(' ');
  return {
    id: 'g20-attributes-10k-distinct',
    title: 'One element with ten thousand different attributes',
    classes: ['resource-exhaustion', 'event-handler'],
    html: `${lead('many attributes')}<div ${names} onmouseover="fetch('{{CANARY}}/{{ID}}/handler-after-10k')" style="background:url({{CANARY}}/{{ID}}/style-after-10k)">element with many attributes</div>${tail()}`,
    expect: { mustKeepText: ['many attributes', 'element with many attributes'] },
    promise: { occurrences: [{ needle: ' a9999="v9999"', count: 1 }] },
  };
}

function attributesDuplicate(): Draft {
  const repeated = ' class="c"'.repeat(10_000);
  const sources = ' src="x"'.repeat(10_000);
  return {
    id: 'g21-attributes-10k-duplicates',
    title: 'Ten thousand repeats of the same attribute',
    classes: ['resource-exhaustion', 'mxss'],
    html: `${lead('repeated attributes')}<div${repeated}>repeated class</div><img src="{{CANARY}}/{{ID}}/first-source"${sources} alt="">${tail()}`,
    expect: { mustKeepText: ['repeated attributes'] },
    promise: { occurrences: [{ needle: ' class="c"', count: 10_000 }] },
  };
}

function attributeValues(): Draft {
  const megabyte = 'q'.repeat(1024 * 1024);
  const declarations = fill('color:#abcdef;', 2 * 1024 * 1024);
  return {
    id: 'g22-attribute-values-huge',
    title: 'Attributes with values of one to two megabytes',
    classes: ['resource-exhaustion', 'huge-line', 'css-url'],
    html: `${lead('huge attribute values')}<img src="{{CANARY}}/{{ID}}/huge-alt" alt="${megabyte}" title="${megabyte}" width="40" height="40"><p style="${declarations}background:url({{CANARY}}/{{ID}}/huge-style)" class="${megabyte}" data-x="${megabyte}">styled</p><a href="data:text/plain,${megabyte}">data link</a>${tail()}`,
    expect: { mustKeepText: ['huge attribute values'] },
    promise: { minChars: 6 * 1024 * 1024, singleLine: true },
  };
}

function manyImages(): Draft {
  const images = Array.from(
    { length: 2_000 },
    (_, i) =>
      `<img src="{{CANARY}}/{{ID}}/img-${String(i).padStart(4, '0')}" width="20" height="20" alt="">`,
  ).join('');
  const links = Array.from(
    { length: 2_000 },
    (_, i) =>
      `<link rel="prefetch" href="{{CANARY}}/{{ID}}/prefetch-${String(i).padStart(4, '0')}">`,
  ).join('');
  return {
    id: 'g23-many-remote-resources-4k',
    title: 'Two thousand images and two thousand prefetch links',
    classes: ['remote-image', 'link-prefetch', 'resource-exhaustion'],
    html: `${lead('many remote resources')}${images}${links}${tail()}`,
    expect: { mustKeepText: ['many remote resources'] },
    promise: { occurrences: [{ needle: '<img ', count: 2_000 }] },
  };
}

function cssBomb(): Draft {
  const rules = Array.from(
    { length: 30_000 },
    (_, i) => `.r${i}{color:#${(i % 0xffffff).toString(16).padStart(6, '0')};margin:${i % 7}px}`,
  ).join('');
  const urlRules = Array.from(
    { length: 5_000 },
    (_, i) => `.u${i}{background:url({{CANARY}}/{{ID}}/css-url-${String(i).padStart(4, '0')})}`,
  ).join('');
  const imports = Array.from(
    { length: 2_000 },
    (_, i) => `@import url({{CANARY}}/{{ID}}/css-import-${String(i).padStart(4, '0')});`,
  ).join('');
  const fonts = Array.from(
    { length: 2_000 },
    (_, i) =>
      `@font-face{font-family:f${i};src:url({{CANARY}}/{{ID}}/css-font-${String(i).padStart(4, '0')})}`,
  ).join('');
  return {
    id: 'g24-css-bomb-many-rules',
    title: 'A style block with tens of thousands of rules, imports and fonts',
    classes: ['css-url', 'css-import', 'css-font-face', 'resource-exhaustion'],
    html: `<style>${imports}${fonts}${rules}${urlRules}</style>${lead('large style block')}${tail()}`,
    expect: { mustKeepText: ['large style block'] },
    promise: { occurrences: [{ needle: '@import url(', count: 2_000 }] },
  };
}

function cssNesting(): Draft {
  const depth = 5_000;
  const media = '@media screen{'.repeat(depth) + '.x{color:red}' + '}'.repeat(depth);
  const is = ':is('.repeat(depth) + 'a' + ')'.repeat(depth);
  const calc = 'calc('.repeat(depth) + '1px' + ')'.repeat(depth);
  const parens = 'url(' + '('.repeat(100_000);
  return {
    id: 'g25-css-deep-nesting',
    title: 'Style rules nested five thousand deep, and a hundred thousand open parentheses',
    classes: ['css-url', 'deep-nesting', 'resource-exhaustion'],
    html: `<style>${media}${is}{color:red}.p{width:${calc};background:url({{CANARY}}/{{ID}}/after-calc)}.q{background:${parens}}</style>${lead('deep style nesting')}${tail()}`,
    expect: { mustKeepText: ['deep style nesting'] },
    promise: { occurrences: [{ needle: '@media screen{', count: depth }] },
  };
}

function htmlBackTracking(): Draft {
  const unit = (text: string, n: number) => text.repeat(n);
  return {
    id: 'g26-parser-redos-shapes',
    title: 'Markup shaped to make a slow parser backtrack',
    classes: ['resource-exhaustion', 'mxss', 'huge-line'],
    html: [
      lead('parser backtracking shapes'),
      unit('<!--', 200_000),
      unit('<a ', 100_000),
      unit('<a b="', 100_000),
      unit("<a b='", 100_000),
      unit('&#', 300_000),
      unit('&', 300_000),
      unit('<![CDATA[', 100_000),
      unit('<', 500_000),
      `<img ${' '.repeat(1_000_000)}src="{{CANARY}}/{{ID}}/spaces-in-tag">`,
      unit('<style>', 50_000),
      unit('<script>', 50_000),
      unit('</', 200_000),
      unit('<svg><title>', 20_000),
      unit('<!DOCTYPE ', 100_000),
      tail(),
    ].join(''),
    expect: { mustKeepText: ['parser backtracking shapes'] },
    promise: { singleLine: true, minChars: 3_000_000 },
  };
}

function cssBackTracking(): Draft {
  return {
    id: 'g27-css-redos-shapes',
    title: 'Style text shaped to make a slow tokenizer backtrack',
    classes: ['css-url', 'resource-exhaustion', 'huge-line'],
    html: `<style>${[
      '/*'.repeat(300_000),
      'url('.repeat(100_000),
      '\\'.repeat(500_000),
      'url("'.repeat(100_000),
      '@import'.repeat(100_000),
      '{'.repeat(200_000),
      '}'.repeat(200_000),
      ';'.repeat(500_000),
      'u\\72l('.repeat(50_000),
    ].join(' ')}</style>${lead('style backtracking shapes')}${tail()}`,
    expect: { mustKeepText: ['style backtracking shapes'] },
    promise: { singleLine: true, minChars: 3_000_000 },
  };
}

export function sizeEntries(): Draft[] {
  return [
    textLine(),
    tagLine(),
    styleLine(),
    attributeLine(),
    commentLine(),
    unterminatedComment(),
    dataUriImage(),
    longImageUrl(),
    attributesDistinct(),
    attributesDuplicate(),
    attributeValues(),
    manyImages(),
    cssBomb(),
    cssNesting(),
    htmlBackTracking(),
    cssBackTracking(),
  ];
}
