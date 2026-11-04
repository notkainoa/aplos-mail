# Hostile email corpus

Original hostile and benign email bodies that grade the Aplos Mail HTML sanitizer, the sealed `aplos-mail://` frame and the
image proxy (plan 10 E4; work package html-2). The leak harness lives in `apps/desktop/tests/eng-html/`.

- `messages/NNN-slug.html` (and an optional `.txt` text alternative): hand-written bodies. Headers are not included.
- `manifest.json`: one record per message: `id`, `title`, `classes`, `html`, `text`, `cids`, `findQuery`, `expect`.
- `generated*.ts`: synthetic entries built in memory (100,000-deep nesting, 5 MB single lines, malformed encodings,
  ten thousand attributes, style and parser bombs). Nothing multi-megabyte is committed.
- `index.ts`: `loadCorpus({ canaryOrigin, dnsSuffix? })`, `ATTACK_CLASSES`, and the `CorpusEntry` type.

## Placeholders

The loader replaces these in every message file, text file and cid:

| Placeholder        | Becomes                                                          |
| ------------------ | ---------------------------------------------------------------- |
| `{{CANARY}}`       | the canary HTTP origin, e.g. `http://127.0.0.1:54321`            |
| `{{CANARY_HOST}}`  | a DNS canary host unique to the message, e.g. `m017.canary-dns.example` |
| `{{CANARY_PORT}}`  | the canary port only (for the IP notations in the `ssrf-image` class) |
| `{{ID}}`           | the entry id                                                     |

Rule: every network-reaching vector points at `{{CANARY}}/{{ID}}/<vector>`, at `http://{{CANARY_HOST}}/...`, or (for
alternative IP spellings of loopback) at `...:{{CANARY_PORT}}/{{ID}}/<vector>`. Then any request, DNS lookup or
connection that appears in the canary log or the Chromium net log names the message and the vector that caused it.
`corpus.test.ts` enforces this. The only other absolute URLs allowed are the XML namespace identifiers
(`http://www.w3.org/...`), which are names and are never fetched.

## Expectations

`expect` is only what a correct sanitizer must satisfy, and only where the answer is unambiguous:
`trackersRemovedMin`, `remoteImages` (exact), `quotedCountMin`, `marksMin` (with `findQuery`), `bodyKind`, and
`mustKeepText` (visible text, so a sanitizer that deletes everything fails). `notes` explains judgement calls.
An entry with `marksMin` must give the `findQuery` it is graded with (`packages/mail-html/tests/sanitize.test.ts`
checks this).
Hidden text (the `hidden-content` class) must be kept as text: it is hostile to AI features, not a leak.

## Classes

Every entry lists one or more of `ATTACK_CLASSES` (`index.ts`): script-inline, event-handler, javascript-url,
link-scheme, data-url, meta-refresh, link-prefetch, css-url, css-import, css-font-face, css-image-set, css-legacy,
css-exfil, css-layout-abuse, base-tag, svg-script, svg-foreignobject, svg-other, form-autosubmit, iframe-nested,
object-embed, mxss, dom-clobbering, deep-nesting, huge-line, malformed-encoding, resource-exhaustion, tracking-pixel,
hidden-content, open-redirect-image, ssrf-image, remote-image, remote-font, relative-url, audio-video, ping-attr,
meta-misc, storage-cookie, popup-navigation, postmessage-spoof, quoted-history, find-text, plain-text, cid-inline,
benign-newsletter, unicode-bidi. A class is covered when at least one entry names it; the test fails otherwise.

Two entries are owner demos: `001-tracking-three-pixels` ("A message that tries to track you") and
`002-runs-code-everywhere` ("A message that tries to run code").

## Rules for new messages

Original content only (write it yourself). Only `*.example` domains, the placeholders above, and obviously fake people.
No real tracking domains, brands, mailbox data or credentials. A message that a sanitizer found a way through becomes
a new entry with a fix.
