import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReportStore, slugFor, type GraveyardReport, type Tombstone } from '@necromancer/core';
import { createProgram } from '../src/index.js';

const SOURCE = 'https://github.com/owner/old-app';

function graveyard(): GraveyardReport {
  const lodash: Tombstone = {
    name: 'lodash', declared: '^4.17.4', dev: false, resolved: '4.17.4', resolvedFrom: 'lockfile', latest: '4.18.1', majorsBehind: 0,
    lastPublished: null, repository: null, status: 'ailing', causes: [{ kind: 'vulnerable', detail: '10 advisories' }], replacement: null, epitaph: '',
    advisories: [{ id: 'GHSA-1', title: 'Prototype pollution', severity: 'high', url: null, vulnerableVersions: '<4.17.21' }],
  };
  return {
    repo: { source: SOURCE, commit: null },
    era: { born: null, died: null, dependencyFloor: null, node: null, estimate: null, confidence: 'none', summary: '' },
    summary: { total: 1, dead: 0, dying: 0, ailing: 1, alive: 0, unknown: 0, vulnerable: 1 },
    tombstones: [lodash],
    sources: { registry: 'ok', advisories: 'ok', advisoryProvider: 'osv', github: 'skipped' },
    nonRegistry: [],
    warnings: [],
  };
}

describe('necromancer plan', () => {
  afterEach(() => vi.restoreAllMocks());

  it('saves plan.json and plan.md and prints the Markdown', async () => {
    const reports = await mkdtemp(path.join(os.tmpdir(), 'necro-cli-plan-'));
    await new ReportStore(reports).save('graveyard', graveyard());
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await createProgram().parseAsync(['node', 'necromancer', 'plan', SOURCE, '--reports', reports]);

    const printed = stdout.mock.calls.map((c) => String(c[0])).join('');
    expect(printed).toContain(`# Modernization plan for ${SOURCE}`);
    expect(printed).toContain('### 1. Upgrade lodash from 4.17.4 to 4.18.1');
    const dir = path.join(reports, slugFor(SOURCE));
    expect(await readFile(path.join(dir, 'plan.md'), 'utf8')).toBe(printed);
    const saved = (await new ReportStore(reports).load(slugFor(SOURCE)))!.plan!;
    expect(saved.steps.map((s) => s.id)).toEqual(['upgrade:lodash', 'upgrade-node:24']);
    expect(stderr.mock.calls.map((c) => String(c[0])).join('')).toContain(`2 step(s); saved ${path.join(dir, 'plan.md')} and ${path.join(dir, 'plan.json')}`);

    stdout.mockClear();
    await createProgram().parseAsync(['node', 'necromancer', 'plan', SOURCE, '--reports', reports, '--json']);
    expect(JSON.parse(stdout.mock.calls.map((c) => String(c[0])).join('')).steps).toHaveLength(2);
  });

  it('needs a saved graveyard report', async () => {
    const reports = await mkdtemp(path.join(os.tmpdir(), 'necro-cli-plan-'));
    await expect(createProgram().parseAsync(['node', 'necromancer', 'plan', SOURCE, '--reports', reports])).rejects.toThrow(
      /no graveyard report saved for .*necromancer autopsy/,
    );
  });
});
