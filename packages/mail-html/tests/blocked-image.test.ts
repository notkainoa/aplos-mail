import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { render } from '../src/index';
import { BLOCKED_IMAGE_CAP } from '../src/reading-css';

// A blocked remote image keeps its width but never its height (owner's hands-on pass 2026-11-12: an itinerary that
// opens with a hero image filled the first screen with a gray slab). The cap must hold against the mail's own CSS.
describe('blocked image placeholder', () => {
  it('is capped in the protected layer and carries no style of its own', () => {
    const result = render({
      html: '<img src="https://cdn.example/hero.png" width="640" height="900" alt="Trip" style="min-height:900px;max-height:none!important;padding:400px 0">',
      cids: [],
      imagePolicy: 'block',
    });
    assert.equal(result.bodyKind, 'html');
    if (result.bodyKind !== 'html') return;
    // The element's own style outranks every layer, so the placeholder carries none.
    assert.match(
      result.document,
      /<img src="data:image\/gif;base64,[^"]+" class="aplos-blocked" width="640" height="900" alt="Trip">/,
    );
    // The cap is inside the `aplos-reading` layer (the mail's own !important cannot beat it) and beats min-height.
    const layer = /@layer aplos-reading\{[^}]*\}[^@]*?img\.aplos-blocked\{([^}]*)\}/.exec(
      result.document,
    );
    assert.ok(layer, 'the cap rule is in the reading layer');
    assert.match(layer[1]!, new RegExp(`max-height:${BLOCKED_IMAGE_CAP}px!important`));
    assert.match(layer[1]!, /min-height:0!important/);
    assert.ok(BLOCKED_IMAGE_CAP <= 64);
  });

  it('keeps the box of an image sized only by its style, as attributes', () => {
    const result = render({
      html: '<img src="https://cdn.example/hero.png" alt="Trip" style="width:640px;height:900px;display:block">',
      cids: [],
      imagePolicy: 'block',
    });
    assert.equal(result.bodyKind, 'html');
    if (result.bodyKind !== 'html') return;
    assert.match(result.document, /class="aplos-blocked" alt="Trip" width="640" height="900">/);
    assert.doesNotMatch(result.document, /<img[^>]*style=/);
  });
});
