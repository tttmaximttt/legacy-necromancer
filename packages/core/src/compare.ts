/** Ordering by UTF-16 code units, not localeCompare, so sorted output is the same under any locale. */
export const compare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
