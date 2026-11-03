/**
 * Quotes a source or path for a POSIX shell command line, leaving plain words, paths and URLs as they are.
 * A value starting with `-` gets a `./` prefix, so a command's option parser does not read it as an option.
 */
export function shellArg(value: string): string {
  const arg = value.startsWith('-') ? `./${value}` : value;
  return /^[\w@%+=:,./-][\w@%+=:,./~-]*$/.test(arg) ? arg : shellQuote(arg);
}

/** Single-quotes any value for a POSIX shell command line, as it is: for text such as an answer, not a path. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
