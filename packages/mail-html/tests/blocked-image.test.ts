import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { render } from '../src/index';

// A blocked remote image collapses to nothing (owner's hands-on pass 2026-11-12, round 3: a gray strip per image hid the
// text of an itinerary). The collapse must hold against the mail's own CSS.
describe('blocked image placeholder', () => {
  it('is collapsed in the protected layer and carries no style of its own', () => {
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
    // The collapse is inside the `aplos-reading` layer (the mail's own !important cannot beat it).
    const layer = /@layer aplos-reading\{[^}]*\}[^@]*?img\.aplos-blocked\{([^}]*)\}/.exec(
      result.document,
    );
    assert.ok(layer, 'the collapse rule is in the reading layer');
    assert.equal(layer[1], 'display:none!important');
    // No unlayered rule gives it a visible strip back.
    assert.doesNotMatch(result.document, /img\.aplos-blocked\{background/);
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
