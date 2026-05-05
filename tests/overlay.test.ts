import { describe, expect, it } from 'vitest';
import { overlayBadgeSvg } from '../src/lib/overlay';

describe('overlayBadgeSvg', () => {
  it('returns null for zero or negative counts', () => {
    expect(overlayBadgeSvg(0)).toBeNull();
    expect(overlayBadgeSvg(-1)).toBeNull();
  });

  it('returns SVG containing the count', () => {
    const svg = overlayBadgeSvg(5);
    expect(svg).toContain('<svg');
    expect(svg).toContain('>5<');
  });

  it('clamps display to "99+" past 99', () => {
    expect(overlayBadgeSvg(100)).toContain('>99+<');
    expect(overlayBadgeSvg(9999)).toContain('>99+<');
  });

  it('uses smaller font for "99+"', () => {
    expect(overlayBadgeSvg(100)).toContain('font-size="24"');
    expect(overlayBadgeSvg(5)).toContain('font-size="32"');
  });
});
