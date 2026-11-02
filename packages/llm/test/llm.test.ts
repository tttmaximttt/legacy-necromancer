import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeModel, LlmError, ScriptedModel, hasCredentials } from '@necromancer/llm';

const Answer = z.object({ answer: z.string(), score: z.number() });

/** A Claude client whose HTTP layer is a stub: no network, no API key. */
function stubClient(respond: (body: Record<string, unknown>) => { status?: number; json: unknown }) {
  const requests: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
  const client = new Anthropic({
    apiKey: 'test-key',
    maxRetries: 0,
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ body, headers: new Headers(init?.headers) });
      const { status = 200, json } = respond(body);
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    },
  });
  return { client, requests };
}

function message(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 120, output_tokens: 30 },
    ...extra,
  };
}

describe('ClaudeModel', () => {
  it('asks for structured output with adaptive thinking, an explicit effort and server-side fallbacks', async () => {
    const { client, requests } = stubClient(() => ({ json: message('{"answer":"forty-two","score":0.9}') }));
    const result = await new ClaudeModel({ client }).generate({ system: 'sys', prompt: 'q?', schema: Answer, effort: 'high' });

    expect(result).toEqual({
      output: { answer: 'forty-two', score: 0.9 },
      model: 'claude-opus-5-5',
      fellBack: false,
      usage: { inputTokens: 120, outputTokens: 30 },
    });
    const { body, headers } = requests[0]!;
    expect(body).toMatchObject({
      model: 'claude-opus-5-5',
      system: 'sys',
      messages: [{ role: 'user', content: 'q?' }],
      thinking: { type: 'adaptive' },
      fallbacks: 'default',
      output_config: { effort: 'high', format: { type: 'json_schema' } },
    });
    expect(JSON.stringify((body.output_config as { format: unknown }).format)).toContain('"score"');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
  });

  it('can leave fallbacks off', async () => {
    const { client, requests } = stubClient(() => ({ json: message('{"answer":"a","score":1}') }));
    await new ClaudeModel({ client, fallbacks: false }).generate({ system: 's', prompt: 'p', schema: Answer });
    expect(requests[0]!.body.fallbacks).toBeUndefined();
    expect(requests[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
  });

  it('reports when the fallback model answered', async () => {
    const { client } = stubClient(() => ({
      json: message('{"answer":"a","score":1}', {
        model: 'claude-opus-5',
        usage: { input_tokens: 1, output_tokens: 1, iterations: [{ type: 'fallback_message', input_tokens: 1, output_tokens: 1 }] },
      }),
    }));
    const result = await new ClaudeModel({ client }).generate({ system: 's', prompt: 'p', schema: Answer });
    expect(result).toMatchObject({ model: 'claude-opus-5', fellBack: true });
  });

  it.each([
    ['unparsed', message('{"answer":"a"}')],
    ['refusal', message('', { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: 'nope' }, content: [] })],
    ['truncated', message('{"answer":"a', { stop_reason: 'max_tokens' })],
  ] as const)('turns stop reason into an LlmError of kind %s', async (kind, json) => {
    const { client } = stubClient(() => ({ json }));
    const err = await new ClaudeModel({ client }).generate({ system: 's', prompt: 'p', schema: Answer }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect((err as LlmError).kind).toBe(kind);
  });

  it.each([
    [401, 'credentials'],
    [429, 'rate_limit'],
    [529, 'overloaded'],
    [400, 'api'],
  ] as const)('maps HTTP %i to %s', async (status, kind) => {
    const { client } = stubClient(() => ({ status, json: { type: 'error', error: { type: 'x', message: 'boom' } } }));
    const err = await new ClaudeModel({ client }).generate({ system: 's', prompt: 'p', schema: Answer }).catch((e: unknown) => e);
    expect((err as LlmError).kind).toBe(kind);
  });

  it('detects credentials in the environment', () => {
    expect(hasCredentials({})).toBe(false);
    expect(hasCredentials({ ANTHROPIC_API_KEY: 'k' })).toBe(true);
    expect(hasCredentials({ ANTHROPIC_AUTH_TOKEN: 't' })).toBe(true);
  });
});

describe('ScriptedModel', () => {
  it('replays answers in order and records requests', async () => {
    const model = new ScriptedModel({ answer: 'one', score: 1 }, (req: { prompt: string }) => ({ answer: req.prompt, score: 2 }));
    expect((await model.generate({ system: 's', prompt: 'a', schema: Answer })).output.answer).toBe('one');
    expect((await model.generate({ system: 's', prompt: 'echo', schema: Answer })).output.answer).toBe('echo');
    expect(model.requests).toHaveLength(2);
    await expect(model.generate({ system: 's', prompt: 'p', schema: Answer })).rejects.toThrow(/ran out/);
  });

  it('rejects fixtures that do not match the schema', async () => {
    await expect(new ScriptedModel({ answer: 1 }).generate({ system: 's', prompt: 'p', schema: Answer })).rejects.toMatchObject({ kind: 'unparsed' });
  });
});
