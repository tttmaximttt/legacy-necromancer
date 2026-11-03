import { describe, expect, it } from 'vitest';
import { imageTag, imageVariant, nodeLine } from '@necromancer/core';

describe('node image helpers', () => {
  it('reads the tag and variant of plain and registry-prefixed images', () => {
    expect(imageTag('node:8-slim')).toBe('8-slim');
    expect(imageTag('registry.example/node:0.10-slim')).toBe('0.10-slim');
    expect(imageVariant('node:8')).toBe('');
    expect(imageVariant('node:0.10-slim')).toBe('slim');
    expect(imageVariant('registry.example/node:6-stretch-slim')).toBe('stretch-slim');
  });

  it('names the release line', () => {
    expect(nodeLine('node:0.10-slim')).toBe('0.10');
    expect(nodeLine('registry.example/node:16-slim')).toBe('16');
  });
});
