import type { AttackClass } from './index';
import { lead, type Draft } from './generated-support';

// Messages that stop in the middle of a construct, as a cut-off download or a hostile sender would leave them.

interface Ending {
  slug: string;
  title: string;
  tail: string;
  extra: AttackClass[];
}

const ENDINGS: Ending[] = [
  {
    slug: 'image-value',
    title: 'ends inside an image address',
    tail: '<img src="{{CANARY}}/{{ID}}/cut-image-value',
    extra: ['remote-image'],
  },
  {
    slug: 'image-tag',
    title: 'ends inside an image tag after its address',
    tail: '<img src="{{CANARY}}/{{ID}}/cut-image-tag" ',
    extra: ['remote-image'],
  },
  {
    slug: 'attribute-name',
    title: 'ends right after an attribute name and equals sign',
    tail: '<img onerror=',
    extra: ['event-handler'],
  },
  {
    slug: 'style-url',
    title: 'ends inside a style url()',
    tail: '<style>.a{background:url({{CANARY}}/{{ID}}/cut-style-url',
    extra: ['css-url'],
  },
  {
    slug: 'style-import',
    title: 'ends inside an import rule',
    tail: '<style>@import url({{CANARY}}/{{ID}}/cut-style-import',
    extra: ['css-import'],
  },
  {
    slug: 'script',
    title: 'ends inside a script',
    tail: "<script>fetch('{{CANARY}}/{{ID}}/cut-script",
    extra: ['script-inline'],
  },
  {
    slug: 'javascript-link',
    title: 'ends inside a javascript link',
    tail: '<a href="javascript:fetch(\'{{CANARY}}/{{ID}}/cut-javascript-link',
    extra: ['javascript-url'],
  },
  {
    slug: 'comment',
    title: 'ends inside a comment that hides an image',
    tail: '<!-- <img src="{{CANARY}}/{{ID}}/cut-comment">',
    extra: [],
  },
  {
    slug: 'cdata',
    title: 'ends inside a CDATA section',
    tail: '<![CDATA[ <img src="{{CANARY}}/{{ID}}/cut-cdata">',
    extra: [],
  },
  {
    slug: 'svg-style',
    title: 'ends inside an SVG style',
    tail: '<svg><style>@import url({{CANARY}}/{{ID}}/cut-svg-style',
    extra: ['svg-other', 'css-import'],
  },
  {
    slug: 'textarea',
    title: 'ends inside a textarea that holds markup',
    tail: '<textarea><img src="{{CANARY}}/{{ID}}/cut-textarea">',
    extra: ['remote-image'],
  },
  {
    slug: 'iframe',
    title: 'ends inside a frame tag',
    tail: '<iframe src="{{CANARY}}/{{ID}}/cut-iframe"',
    extra: ['iframe-nested'],
  },
  {
    slug: 'meta-refresh',
    title: 'ends inside a refresh redirect',
    tail: '<meta http-equiv="refresh" content="0;url={{CANARY}}/{{ID}}/cut-meta',
    extra: ['meta-refresh'],
  },
  {
    slug: 'entity',
    title: 'ends inside a character reference',
    tail: '<p>cut here &#x',
    extra: ['malformed-encoding'],
  },
  {
    slug: 'end-tag',
    title: 'ends inside an end tag',
    tail: '<img src="{{CANARY}}/{{ID}}/cut-before-end-tag"></',
    extra: ['remote-image'],
  },
  {
    slug: 'mathml-mxss',
    title: 'ends inside a namespace confusion payload',
    tail: '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src={{CANARY}}/{{ID}}/cut-mxss',
    extra: [],
  },
];

export function truncatedEntries(firstNumber: number): Draft[] {
  return ENDINGS.map((ending, index) => ({
    id: `g${firstNumber + index}-truncated-${ending.slug}`,
    title: `A message that ${ending.title}`,
    classes: ['mxss', 'malformed-encoding', ...ending.extra],
    html: `${lead('truncated document')}${ending.tail}`,
    expect: { mustKeepText: ['truncated document'] },
    promise: { occurrences: [{ needle: 'truncated document', count: 1 }] },
  }));
}
