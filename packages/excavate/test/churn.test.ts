import { describe, expect, it } from 'vitest';
import { parseLog } from '@necromancer/excavate';

const M = '\u0001';

describe('parseLog', () => {
  it('counts commits and distinct authors per file', () => {
    const log = [
      `${M}c3\tann@x.io\t2016-03-01T00:00:00+00:00\n\nlib/a.js\nlib/b.js\n`,
      `${M}c2\tbob@x.io\t2015-02-01T00:00:00+00:00\n\nlib/a.js\n`,
      `${M}c1\tann@x.io\t2014-01-01T00:00:00+00:00\n\nlib/a.js\nREADME.md\n`,
    ].join('');
    const history = parseLog(log);
    expect(history).toMatchObject({
      commits: 3,
      authors: 2,
      firstCommit: '2014-01-01T00:00:00+00:00',
      lastCommit: '2016-03-01T00:00:00+00:00',
    });
    expect(history.files['lib/a.js']).toEqual({ commits: 3, authors: 2, lastTouched: '2016-03-01T00:00:00+00:00' });
    expect(history.files['lib/b.js']).toEqual({ commits: 1, authors: 1, lastTouched: '2016-03-01T00:00:00+00:00' });
  });

  it('handles empty output', () => {
    expect(parseLog('')).toEqual({ commits: 0, authors: 0, firstCommit: null, lastCommit: null, files: {} });
  });
});
