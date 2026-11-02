/** Quotes a value for a POSIX shell command line, leaving plain words, paths and URLs as they are. */
export function shellArg(value: string): string {
  return /^[\w@%+=:,./-][\w@%+=:,./~-]*$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}
