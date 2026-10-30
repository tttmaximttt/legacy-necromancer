import type { TombstoneStatus } from '@necromancer/core';

export type Mode = 'light' | 'dark';

/**
 * Categorical slots in fixed order, validated for CVD separation in both
 * modes. Clusters past the eighth fold into "other" rather than getting a
 * generated hue.
 */
export const CATEGORICAL: Record<Mode, string[]> = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
export const OTHER: Record<Mode, string> = { light: '#a3a29b', dark: '#6b6a64' };
export const MAX_COLORED_CLUSTERS = CATEGORICAL.light.length;

/** Cluster ids are ranked by size, so colours follow the cluster, not a filter's ordering. */
export function clusterColor(cluster: number, mode: Mode): string {
  return cluster >= 0 && cluster < MAX_COLORED_CLUSTERS ? CATEGORICAL[mode][cluster]! : OTHER[mode];
}

/** Reserved status colours; always shown with an icon and a word, never alone. */
export const STATUS: Record<TombstoneStatus, { color: string; icon: string; label: string }> = {
  dead: { color: '#d03b3b', icon: '✝', label: 'Dead' },
  dying: { color: '#ec835a', icon: '⌛', label: 'Dying' },
  ailing: { color: '#fab219', icon: '⚠', label: 'Ailing' },
  alive: { color: '#0ca30c', icon: '✓', label: 'Alive' },
  unknown: { color: '#8a8984', icon: '?', label: 'Unknown' },
};
