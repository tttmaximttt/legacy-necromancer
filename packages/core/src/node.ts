/**
 * The Node release line a version or image tag names: "0.10" and "0.12" for the 0.x lines, the major from 4 on.
 * Accepts "node:0.10-slim", "registry.example/node:8", "14.21.3", "v8" and the like; null for tags with no version ("lts", "argon", a bare "0").
 */
export function nodeLine(value: string | null | undefined): string | null {
  const tag = imageTag(value);
  const m = tag?.match(/^v?(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  if (m[1] !== '0') return String(Number(m[1]));
  return m[2] === undefined ? null : `0.${Number(m[2])}`;
}

/** The tag of a Node image reference: "8-slim" for "node:8-slim" or "registry.example/node:8-slim"; anything else is returned unchanged. */
export function imageTag(image: string | null | undefined): string | undefined {
  return image?.replace(/^.*\bnode:/, '');
}

/** The variant part of a Node image tag ("alpine", "stretch-slim"), or '' for the default image of that version. */
export function imageVariant(image: string): string {
  return /^[^-]*-(.*)$/.exec(imageTag(image)!)?.[1] ?? '';
}
