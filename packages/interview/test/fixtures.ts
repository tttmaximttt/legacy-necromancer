import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { RawProposal } from '@necromancer/interview';

/** A tiny abandoned project: a query builder with a CLI. */
export async function fixtureRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'necro-interview-'));
  await mkdir(path.join(root, 'lib'));
  await mkdir(path.join(root, 'bin'));
  await writeFile(
    path.join(root, 'README.md'),
    '# tinyquery\n\nA chainable SQL query builder for Node.\n\n## Usage\n\n    tq("users").where({ id: 1 })\n',
  );
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'tinyquery', main: 'lib/index.js', bin: { tq: 'bin/tq.js' }, engines: { node: '>=0.10' } }, null, 2),
  );
  await writeFile(path.join(root, 'lib/index.js'), "var Builder = require('./builder');\n\nmodule.exports = function tq(table) {\n  return new Builder(table);\n};\n");
  await writeFile(
    path.join(root, 'lib/builder.js'),
    "var escape = require('./escape');\n\nfunction Builder(table) {\n  this.table = table;\n}\n\nBuilder.prototype.where = function (clause) {\n  this.clause = escape(clause);\n  return this;\n};\n\nmodule.exports = Builder;\n",
  );
  await writeFile(path.join(root, 'lib/escape.js'), "module.exports = function escape(v) {\n  return String(v).replace(/'/g, \"''\");\n};\n");
  await writeFile(path.join(root, 'bin/tq.js'), "#!/usr/bin/env node\nvar tq = require('../lib');\nconsole.log(tq(process.argv[2]));\n");
  return root;
}

export const goodProposal: RawProposal = {
  summary: 'A chainable SQL query builder for Node, with a small CLI.',
  capabilities: [
    {
      claim: 'Builds queries with a chainable API',
      evidence: [{ file: 'lib/builder.js', startLine: 7, endLine: 10, quote: 'Builder.prototype.where = function (clause) { ... return this;' }],
    },
    {
      // Right quote, wrong lines: should be corrected, not rejected.
      claim: 'Escapes single quotes in values',
      evidence: [{ file: 'lib/escape.js', startLine: 40, endLine: 40, quote: `return String(v).replace(/'/g, "''");` }],
    },
  ],
  constraints: [
    {
      claim: 'Ships a `tq` command',
      evidence: [
        { file: 'package.json', startLine: 4, endLine: 6, quote: '"tq": "bin/tq.js"' },
        { file: 'lib/missing.js', startLine: 1, endLine: 2, quote: 'nothing here' },
      ],
    },
  ],
  suggestedGoals: ['Keep the where() API stable', 'Support Node 22', 'Publish ESM types'],
  openQuestions: ['Is the CLI still used?'],
  confidence: 'medium',
};
