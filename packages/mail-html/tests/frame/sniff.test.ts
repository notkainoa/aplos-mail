import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sniffRaster } from '../../src/frame/sniff';
import { bytes, SAMPLES } from './fixtures';

// The sub-resource type comes from the bytes alone: four raster signatures, nothing else.

describe('sniffRaster', () => {
  it('recognises PNG, JPEG, GIF and WebP by their leading bytes', () => {
    assert.equal(sniffRaster(SAMPLES.png), 'image/png');
    assert.equal(sniffRaster(SAMPLES.jpeg), 'image/jpeg');
    assert.equal(sniffRaster(SAMPLES.gif87), 'image/gif');
    assert.equal(sniffRaster(SAMPLES.gif89), 'image/gif');
    assert.equal(sniffRaster(SAMPLES.webp), 'image/webp');
  });

  it('refuses SVG, HTML, scripts, executables and truncated signatures', () => {
    const refused: unknown[] = [
      bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>1</script></svg>'),
      bytes('<?xml version="1.0"?><svg/>'),
      bytes('<!doctype html><script>alert(1)</script>'),
      bytes('<html>'),
      bytes('MZ', 0x90, 0, 3, 0),
      bytes(0x7f, 'ELF'),
      bytes('%PDF-1.7'),
      bytes('RIFF', 36, 0, 0, 0, 'WAVEfmt '),
      bytes(0x89, 'PNG', 0x0d, 0x0a, 0x1a),
      bytes(0xff, 0xd8),
      bytes('GIF88a'),
      bytes('RIFF', 0, 0, 0, 0, 'WEB'),
      bytes(' ', 0x89, 'PNG', 0x0d, 0x0a, 0x1a, 0x0a),
      new Uint8Array(0),
      'image/png',
      [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
      undefined,
      null,
    ];
    for (const value of refused) assert.equal(sniffRaster(value), undefined, String(value));
  });
});
