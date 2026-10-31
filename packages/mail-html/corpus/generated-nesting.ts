import { fill, lead, tail, type Draft } from './generated-support';

// 100,000-element nesting in the shapes that stress a parser differently.

const DEPTH = 100_000;

function count(needle: string, n: number) {
  return [{ needle, count: n }];
}

function divUnclosed(): Draft {
  return {
    id: 'g01-nesting-div-unclosed-100k',
    title: 'One hundred thousand open divs and no closing tags',
    classes: ['deep-nesting', 'resource-exhaustion'],
    html: `${lead('unclosed div nesting')}${'<div>'.repeat(DEPTH)}deepest text${tail()}`,
    expect: { mustKeepText: ['unclosed div nesting'] },
    promise: { occurrences: count('<div>', DEPTH) },
  };
}

function divBalanced(): Draft {
  const open = '<div style="margin:0">'.repeat(DEPTH);
  return {
    id: 'g02-nesting-div-balanced-100k',
    title: 'One hundred thousand divs, each properly closed',
    classes: ['deep-nesting', 'resource-exhaustion'],
    html: `${lead('balanced div nesting')}${open}<img src="{{CANARY}}/{{ID}}/inside" width="10" height="10" alt="deep image">deepest${'</div>'.repeat(DEPTH)}${tail()}`,
    expect: { mustKeepText: ['balanced div nesting'] },
    promise: { occurrences: count('<div ', DEPTH) },
  };
}

function tableNesting(): Draft {
  const cells = Math.ceil(DEPTH / 3);
  return {
    id: 'g03-nesting-table-100k',
    title: 'Tables nested thirty-three thousand deep (one hundred thousand elements)',
    classes: ['deep-nesting', 'resource-exhaustion'],
    html: `${lead('nested tables')}${'<table><tr><td>'.repeat(cells)}deepest cell${'</td></tr></table>'.repeat(cells)}${tail()}`,
    expect: { mustKeepText: ['nested tables'] },
    promise: { occurrences: count('<table>', cells) },
  };
}

function fontNesting(): Draft {
  return {
    id: 'g04-nesting-font-100k',
    title: 'One hundred thousand open font tags',
    classes: ['deep-nesting', 'resource-exhaustion', 'mxss'],
    html: `${lead('font nesting')}${'<font color="red" size="2">'.repeat(DEPTH)}text under all the fonts<p>a paragraph that makes the parser rebuild the formatting list</p>${tail()}`,
    expect: { mustKeepText: ['font nesting'] },
    promise: { occurrences: count('<font ', DEPTH) },
  };
}

function formattingMisnest(): Draft {
  const pairs = DEPTH / 2;
  return {
    id: 'g05-nesting-formatting-misnested-100k',
    title: 'Bold and italic tags opened fifty thousand times and closed in the wrong order',
    classes: ['deep-nesting', 'resource-exhaustion', 'mxss'],
    html: `${lead('misnested formatting')}${'<b><i>'.repeat(pairs)}text${'</b></i>'.repeat(pairs)}<p>after</p>${tail()}`,
    expect: { mustKeepText: ['misnested formatting'] },
    promise: { occurrences: count('<b><i>', pairs) },
  };
}

function spanNesting(): Draft {
  return {
    id: 'g06-nesting-span-styled-100k',
    title: 'One hundred thousand styled spans',
    classes: ['deep-nesting', 'resource-exhaustion', 'css-url'],
    html: `${lead('styled span nesting')}${'<span style="color:#123456">'.repeat(DEPTH)}text${'</span>'.repeat(DEPTH)}${tail()}`,
    expect: { mustKeepText: ['styled span nesting'] },
    promise: { occurrences: count('<span ', DEPTH) },
  };
}

function svgNesting(): Draft {
  return {
    id: 'g07-nesting-svg-groups-100k',
    title: 'An SVG with one hundred thousand nested groups',
    classes: ['deep-nesting', 'svg-other', 'resource-exhaustion'],
    html: `${lead('svg nesting')}<svg width="10" height="10">${'<g>'.repeat(DEPTH)}<circle r="1"/>${'</g>'.repeat(DEPTH)}</svg>${tail()}`,
    expect: { mustKeepText: ['svg nesting'] },
    promise: { occurrences: count('<g>', DEPTH) },
  };
}

function quoteNesting(): Draft {
  const depth = 5_000;
  const open = '<div class="gmail_quote"><blockquote type="cite">On Mon someone wrote:<br>'.repeat(
    depth,
  );
  return {
    id: 'g08-nesting-quotes-5k',
    title: 'A reply chain quoted five thousand levels deep',
    classes: ['deep-nesting', 'quoted-history', 'resource-exhaustion'],
    html: `${lead('quoted reply chain')}${open}the oldest message${'</blockquote></div>'.repeat(depth)}${tail()}`,
    expect: { mustKeepText: ['quoted reply chain'], quotedCountMin: 1 },
    promise: { occurrences: count('<blockquote', depth) },
  };
}

function listNesting(): Draft {
  const depth = 50_000;
  return {
    id: 'g09-nesting-lists-50k',
    title: 'Lists inside lists fifty thousand levels deep',
    classes: ['deep-nesting', 'resource-exhaustion'],
    html: `${lead('nested lists')}${'<ul><li>'.repeat(depth)}item${'</li></ul>'.repeat(depth)}${tail()}`,
    expect: { mustKeepText: ['nested lists'] },
    promise: { occurrences: count('<ul>', depth) },
  };
}

function mathNesting(): Draft {
  const depth = 50_000;
  return {
    id: 'g10-nesting-mathml-50k',
    title: 'MathML rows nested fifty thousand deep',
    classes: ['deep-nesting', 'mxss', 'resource-exhaustion'],
    html: `${lead('mathml nesting')}<math>${'<mrow>'.repeat(depth)}<mi>x</mi>${'</mrow>'.repeat(depth)}</math>${tail()}`,
    expect: { mustKeepText: ['mathml nesting'] },
    promise: { occurrences: count('<mrow>', depth) },
  };
}

function wideSiblings(): Draft {
  return {
    id: 'g11-siblings-wide-200k',
    title: 'Two hundred thousand sibling elements in one parent',
    classes: ['deep-nesting', 'resource-exhaustion'],
    html: `${lead('wide sibling list')}<div>${fill('<i>x</i>', 200_000 * 8)}</div>${tail()}`,
    expect: { mustKeepText: ['wide sibling list'] },
    promise: { occurrences: count('<i>', 200_000) },
  };
}

export function nestingEntries(): Draft[] {
  return [
    divUnclosed(),
    divBalanced(),
    tableNesting(),
    fontNesting(),
    formattingMisnest(),
    spanNesting(),
    svgNesting(),
    quoteNesting(),
    listNesting(),
    mathNesting(),
    wideSiblings(),
  ];
}
