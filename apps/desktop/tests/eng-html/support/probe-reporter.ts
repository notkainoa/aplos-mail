import { createHash } from 'node:crypto';

// The harness's stand-in for the frame's reporter script (plan 10 E4 item 5; html-4 ships the real one). It is the one
// script the CSP lets run (script-src 'sha256-...'), so the mail's own scripts never do. On a 'collect' message from the
// host page it answers with the fields the real reporter would send (h, w, bg, ready) plus what only a test needs:
//
//  - `violations`: every CSP violation the document raised. The sanitizer must not rely on the CSP, so any entry is a
//    finding even though the policy stopped the load.
//  - `newGlobals`, `pwned`, `name`: signs that a script of the mail ran (the corpus has no script that sets a marker,
//    so the marker is the `__pwned` convention plus any new property on `window`).
//  - `storage`: what a write to localStorage, sessionStorage, cookies and IndexedDB did. An opaque-origin sandbox
//    must refuse all of them.
//  - `cssUrls`, `importRules`, `fontFaceRules`, `fonts`: what Chromium's own CSSOM and computed styles hold, to check
//    the sanitizer's CSS tokenizer against the browser's.
//
// The source is plain ES5-ish text so its SHA-256 is stable; html-4 replaces both the script and this helper.

const PROBE_SOURCE = String.raw`(function () {
  var violations = [];
  var baseline = Object.getOwnPropertyNames(window);
  document.addEventListener('securitypolicyviolation', function (e) {
    violations.push(e.effectiveDirective + ' ' + String(e.blockedURI).slice(0, 160));
  });
  function attempt(fn) {
    try {
      var r = fn();
      return r === undefined ? 'ok' : String(r);
    } catch (e) {
      return 'threw ' + (e && e.name);
    }
  }
  function storage(done) {
    var out = {
      localStorage: attempt(function () { localStorage.setItem('k', 'v'); return localStorage.getItem('k'); }),
      sessionStorage: attempt(function () { sessionStorage.setItem('k', 'v'); return sessionStorage.getItem('k'); }),
      cookie: attempt(function () { document.cookie = 'k=v; path=/'; return document.cookie; }),
      indexedDB: 'pending',
    };
    try {
      var open = indexedDB.open('probe');
      open.onsuccess = function () { out.indexedDB = 'opened'; done(out); };
      open.onerror = function () { out.indexedDB = 'error'; done(out); };
      setTimeout(function () { done(out); }, 150);
    } catch (e) {
      out.indexedDB = 'threw ' + (e && e.name);
      done(out);
    }
  }
  var URL_PROPS = ['background-image', 'list-style-image', 'border-image-source', 'mask-image', '-webkit-mask-image',
    '-webkit-mask-box-image-source', 'shape-outside', 'content', 'cursor', 'filter', 'backdrop-filter', 'clip-path',
    'offset-path', '-webkit-box-reflect'];
  var PSEUDO = ['::before', '::after', '::marker', '::first-line', '::first-letter', '::selection', '::placeholder'];
  function css() {
    var urls = [];
    var re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/g;
    function scan(text, where) {
      var m;
      re.lastIndex = 0;
      while ((m = re.exec(text))) urls.push(where + '|' + (m[1] || m[2] || m[3]));
    }
    var imports = 0;
    var fontFaces = 0;
    for (var s = 0; s < document.styleSheets.length; s++) {
      var rules;
      try { rules = document.styleSheets[s].cssRules; } catch (e) { continue; }
      for (var r = 0; r < rules.length; r++) {
        if (rules[r].type === 3) imports++;
        if (rules[r].type === 5) fontFaces++;
        scan(rules[r].cssText, 'rule');
      }
    }
    var all = document.querySelectorAll('*');
    var limit = Math.min(all.length, 6000);
    for (var i = 0; i < limit; i++) {
      var cs = getComputedStyle(all[i]);
      for (var p = 0; p < URL_PROPS.length; p++) scan(cs.getPropertyValue(URL_PROPS[p]), URL_PROPS[p]);
      if (i < 300) {
        for (var q = 0; q < PSEUDO.length; q++) {
          var ps = getComputedStyle(all[i], PSEUDO[q]);
          scan(ps.getPropertyValue('content'), PSEUDO[q] + ' content');
          scan(ps.getPropertyValue('background-image'), PSEUDO[q] + ' background-image');
        }
      }
    }
    return { cssUrls: urls, importRules: imports, fontFaceRules: fontFaces, fonts: document.fonts ? document.fonts.size : 0, computedElements: limit };
  }
  function report() {
    storage(function (st) {
      if (report.sent) return;
      report.sent = true;
      var body = {
        type: 'report',
        token: location.pathname.split('/')[2],
        h: document.documentElement.scrollHeight,
        w: window.innerWidth,
        bg: getComputedStyle(document.body).backgroundColor,
        ready: document.readyState === 'complete',
        violations: violations,
        newGlobals: Object.getOwnPropertyNames(window).filter(function (n) { return baseline.indexOf(n) < 0; }),
        pwned: typeof window.__pwned,
        name: window.name,
        storage: st,
        origin: String(window.origin),
      };
      var c = css();
      for (var k in c) body[k] = c[k];
      parent.postMessage(body, '*');
    });
  }
  window.addEventListener('message', function (e) {
    if (e.data === 'collect') { report.sent = false; report(); }
  });
})();`;

export const PROBE_REPORTER = {
  source: PROBE_SOURCE,
  /** CSP source expression for the script: 'sha256-<base64>'. */
  cspHash: `'sha256-${createHash('sha256').update(PROBE_SOURCE, 'utf8').digest('base64')}'`,
};

/** Puts the reporter first in `<head>`, where it can see CSP violations from the rest of the document. */
export function injectReporter(document: string): string {
  const head = document.indexOf('<head>');
  if (head < 0) throw new Error('sanitized document has no <head>');
  const at = head + '<head>'.length;
  return `${document.slice(0, at)}<script>${PROBE_SOURCE}</script>${document.slice(at)}`;
}

export interface ProbeReport {
  type: 'report';
  token: string;
  h: number;
  w: number;
  bg: string;
  ready: boolean;
  violations: string[];
  newGlobals: string[];
  pwned: string;
  name: string;
  storage: { localStorage: string; sessionStorage: string; cookie: string; indexedDB: string };
  origin: string;
  cssUrls: string[];
  importRules: number;
  fontFaceRules: number;
  fonts: number;
  computedElements: number;
}
