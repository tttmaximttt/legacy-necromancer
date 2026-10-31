import type { WitnessCase } from '@necromancer/core';
import { MARKER } from '@necromancer/witness';
import type { ExecHandler } from '../../resurrect/test/helpers.js';

/** An exec handler that answers the request runner from a function, without a network, and passes the tests. */
export function answering(respond: (c: WitnessCase) => { status: number; body: unknown }): ExecHandler {
  return (command, env) => {
    if (command[0] !== 'node') return { ok: true, log: '  2 passing (4ms)\n', durationMs: 1 };
    const cases = JSON.parse(Buffer.from(env.WITNESS_CASES!, 'base64').toString('utf8')) as WitnessCase[];
    const lines = cases.flatMap((c, i) => {
      const { status, body } = respond(c);
      const line = (repeat: number) => MARKER + JSON.stringify({ i, repeat, status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), error: null });
      return c.method === 'GET' ? [line(0), line(1)] : [line(0)];
    });
    return { ok: true, log: lines.join('\n'), durationMs: 1 };
  };
}
