import type { Replacement } from '@necromancer/core';

/**
 * Curated successors for packages that are famously dead or that modern Node
 * makes unnecessary. Checked before the deprecation message, because those
 * messages are often vague ("no longer supported").
 */
export const KNOWN_REPLACEMENTS: Record<string, { name: string; reason: string }> = {
  request: { name: 'fetch (built in since Node 18) or undici', reason: 'request was deprecated in 2020' },
  'request-promise': { name: 'fetch (built in since Node 18) or undici', reason: 'wraps the deprecated request' },
  'request-promise-native': { name: 'fetch (built in since Node 18) or undici', reason: 'wraps the deprecated request' },
  'node-sass': { name: 'sass', reason: 'LibSass is deprecated; node-sass also needs a native build per Node version' },
  'node-uuid': { name: 'uuid', reason: 'renamed' },
  'coffee-script': { name: 'coffeescript', reason: 'renamed' },
  jade: { name: 'pug', reason: 'renamed after a trademark issue' },
  'gulp-util': { name: 'the individual packages it bundled (vinyl, plugin-error, fancy-log, …)', reason: 'split up in 2017' },
  phantomjs: { name: 'playwright', reason: 'PhantomJS was abandoned in 2018' },
  'phantomjs-prebuilt': { name: 'playwright', reason: 'PhantomJS was abandoned in 2018' },
  istanbul: { name: 'c8', reason: 'istanbul 0.x is unmaintained; c8 uses V8 coverage' },
  tslint: { name: 'eslint with typescript-eslint', reason: 'TSLint was deprecated in 2019' },
  'babel-eslint': { name: '@babel/eslint-parser', reason: 'renamed in Babel 7' },
  'bcrypt-nodejs': { name: 'bcryptjs', reason: 'unmaintained' },
  fibers: { name: 'async/await', reason: 'fibers does not work on Node 16+' },
  optimist: { name: 'yargs or node:util parseArgs', reason: 'unmaintained since 2014' },
  nomnom: { name: 'commander or node:util parseArgs', reason: 'deprecated' },
  'uglify-js': { name: 'terser', reason: 'uglify-js does not parse ES2015+' },
  'uglify-es': { name: 'terser', reason: 'abandoned fork; terser continued it' },
  karma: { name: 'vitest or web-test-runner', reason: 'Karma was deprecated in 2023' },
  protractor: { name: 'playwright', reason: 'Protractor reached end of life in 2023' },
  enzyme: { name: '@testing-library/react', reason: 'no React 17+ adapter' },
  moment: { name: 'date-fns, dayjs or Luxon', reason: 'moment is in maintenance mode' },
  mkdirp: { name: 'fs.mkdir(path, { recursive: true })', reason: 'built in since Node 10' },
  rimraf: { name: 'fs.rm(path, { recursive: true, force: true })', reason: 'built in since Node 14' },
  'left-pad': { name: 'String.prototype.padStart', reason: 'built in since ES2017' },
  querystring: { name: 'URLSearchParams', reason: 'the npm package is deprecated' },
  'node-fetch': { name: 'fetch (built in since Node 18)', reason: 'no longer needed on modern Node' },
  colors: { name: 'picocolors', reason: 'colors was sabotaged by its author in 2022' },
  'merge': { name: 'structuredClone or object spread', reason: 'had prototype-pollution advisories and is unmaintained' },
  'bower': { name: 'npm', reason: 'Bower is deprecated' },
  'grunt': { name: 'npm scripts or Vite', reason: 'Grunt is effectively unmaintained' },
  'joi-browser': { name: 'joi', reason: 'joi works in browsers now' },
  '@hapi/joi': { name: 'joi', reason: 'moved back to the joi name' },
  hapi: { name: '@hapi/hapi', reason: 'moved to the @hapi scope' },
  'core-js': { name: 'core-js@3', reason: 'core-js 2 is unmaintained' },
  'babel-core': { name: '@babel/core', reason: 'Babel 6 package; Babel 7 moved to the @babel scope' },
  'babel-preset-es2015': { name: '@babel/preset-env', reason: 'Babel 6 preset' },
  mysql: { name: 'mysql2', reason: 'mysql has had no release since 2020; mysql2 is API-compatible' },
  bluebird: { name: 'native Promise and node:util promisify', reason: 'no longer needed on modern Node' },
  q: { name: 'native Promise', reason: 'no longer needed on modern Node' },
  hat: { name: 'crypto.randomUUID()', reason: 'built in since Node 14.17' },
  'node-uuid-v4': { name: 'crypto.randomUUID()', reason: 'built in since Node 14.17' },
  'path-is-absolute': { name: 'path.isAbsolute', reason: 'built in since Node 0.12' },
  'object-assign': { name: 'Object.assign', reason: 'built in since ES2015' },
  'es6-promise': { name: 'native Promise', reason: 'built in since Node 4' },
  'sqlite3': { name: 'node:sqlite (Node 22.5+) or better-sqlite3', reason: 'needs a native build; a common install failure' },
};

/** Packages that are only "replaced" when they are actually deprecated or very old. */
const ONLY_WHEN_DEAD = new Set(['core-js', 'sqlite3', 'moment', 'node-fetch', 'mkdirp', 'rimraf', 'grunt', 'merge', 'bluebird', 'mysql']);

export function suggestReplacement(name: string, deprecation: string | null, dead: boolean): Replacement | null {
  const known = KNOWN_REPLACEMENTS[name];
  if (known && (dead || !ONLY_WHEN_DEAD.has(name))) return { ...known, source: 'known' };
  const fromMessage = deprecation ? replacementFromMessage(deprecation, name) : null;
  if (fromMessage) return { name: fromMessage, reason: `deprecation notice: "${deprecation!.trim()}"`, source: 'deprecation-message' };
  return null;
}

/** Pulls a package name out of notices like "Use @foo/bar instead", "renamed to x", "moved to y", "please use z". */
export function replacementFromMessage(message: string, self: string): string | null {
  const patterns = [
    /(?:use|switch to|migrate to|replaced by|superseded by|in favou?r of)\s+[`'"]?((?:@[\w.-]+\/)?[\w.-]+)[`'"]?/i,
    /(?:renamed|moved)\s+(?:to|into)\s+[`'"]?((?:@[\w.-]+\/)?[\w.-]+)[`'"]?/i,
  ];
  for (const p of patterns) {
    const name = p.exec(message)?.[1]?.replace(/[.,;:]+$/, '');
    if (name && name !== self && /^(@[\w.-]+\/)?[a-z0-9][\w.-]*$/i.test(name) && !STOPWORDS.has(name.toLowerCase())) return name;
  }
  return null;
}

const STOPWORDS = new Set(['the', 'a', 'an', 'this', 'it', 'version', 'latest', 'newer', 'native', 'node', 'npm', 'v2', 'v3']);
