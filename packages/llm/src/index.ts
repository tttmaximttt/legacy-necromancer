import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { fileSettings, usable } from '@necromancer/core';
import type { z } from 'zod';

/**
 * Thin LLM client shared by the stages that need a model. Structured output only: every call returns a value
 * that already matches a zod schema, or throws an LlmError that says why it doesn't.
 */

export const DEFAULT_MODEL = 'claude-opus-5-5';

export type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface StructuredRequest<T> {
  system: string;
  prompt: string;
  schema: z.ZodType<T>;
  effort?: Effort;
  maxTokens?: number;
}

export interface StructuredResult<T> {
  output: T;
  /** The model that produced the answer: the requested one, or the server-side fallback. */
  model: string;
  fellBack: boolean;
  usage: { inputTokens: number; outputTokens: number };
}

/** Anything that turns a prompt into schema-shaped output. Tests use ScriptedModel; the CLI and MCP use ClaudeModel. */
export interface StructuredModel {
  readonly name: string;
  generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

export type LlmErrorKind = 'credentials' | 'refusal' | 'truncated' | 'unparsed' | 'rate_limit' | 'overloaded' | 'api';

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LlmError';
  }
}

export interface ClaudeModelOptions {
  /** Injected in tests or to point at a proxy; defaults to a client built from findCredentials(). */
  client?: Anthropic;
  model?: string;
  /** Re-run a declined request on Anthropic's recommended fallback model, server-side. On by default. */
  fallbacks?: boolean;
}

export class ClaudeModel implements StructuredModel {
  readonly name: string;
  private readonly client: Anthropic | undefined;
  private readonly fallbacks: boolean;

  constructor(options: ClaudeModelOptions = {}) {
    this.name = options.model ?? DEFAULT_MODEL;
    this.client = options.client;
    this.fallbacks = options.fallbacks ?? true;
  }

  async generate<T>({ system, prompt, schema, effort = 'medium', maxTokens = 16_000 }: StructuredRequest<T>): Promise<StructuredResult<T>> {
    const credentials = this.client ? null : findCredentials();
    const client = this.client ?? createClient(credentials);
    let message;
    try {
      message = await client.beta.messages.create({
        model: this.name,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
        thinking: { type: 'adaptive' },
        output_config: { effort, format: betaZodOutputFormat(schema) },
        ...(this.fallbacks && { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
      });
    } catch (err) {
      throw translate(err, credentials);
    }

    if (message.stop_reason === 'refusal') {
      const why = message.stop_details?.explanation ?? message.stop_details?.category ?? 'no reason given';
      throw new LlmError('refusal', `the model declined this request (${why})`);
    }
    if (message.stop_reason === 'max_tokens') {
      throw new LlmError('truncated', `the answer was cut off at ${maxTokens} output tokens`);
    }
    // Parsed here rather than with messages.parse() so a cut-off answer reports as truncated, not as bad JSON.
    const text = message.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new LlmError('unparsed', 'the model answered, but not with JSON', { cause: err });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new LlmError('unparsed', `the model's answer does not match the schema: ${parsed.error.message}`);
    return {
      output: parsed.data,
      model: message.model,
      fellBack: message.model !== this.name || (message.usage.iterations ?? []).some((i) => i.type === 'fallback_message'),
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
    };
  }
}

/** Where an Anthropic key can come from, in the order they are tried. */
const KEY_VARIABLES = ['NECROMANCER_ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;

export interface Credentials {
  apiKey?: string;
  authToken?: string;
  /** From the same place as the key, so a key is never sent to a gateway it wasn't set up for. */
  baseURL: string;
  /** Where the key came from, for error messages. */
  from: string;
}

/**
 * The first of NECROMANCER_ANTHROPIC_API_KEY (the Claude Code plugin's setting), ANTHROPIC_API_KEY and
 * ANTHROPIC_AUTH_TOKEN set in the environment, or else in ~/.necromancer/.env. Only that one credential is used.
 */
export function findCredentials(env: NodeJS.ProcessEnv = process.env, file: Record<string, string> = fileSettings()): Credentials | null {
  const places: Array<[Record<string, string | undefined>, string]> = [
    [env, 'the environment'],
    [file, '~/.necromancer/.env'],
  ];
  for (const [vars, place] of places) {
    const name = KEY_VARIABLES.find((n) => usable(vars[n]));
    if (!name) continue;
    const value = usable(vars[name])!;
    const baseURL = usable(vars.ANTHROPIC_BASE_URL) ?? 'https://api.anthropic.com';
    const from = `${name} in ${place}${name === 'NECROMANCER_ANTHROPIC_API_KEY' && place === 'the environment' ? ' (the plugin setting, if you use the plugin)' : ''}`;
    return name === 'ANTHROPIC_AUTH_TOKEN' ? { authToken: value, baseURL, from } : { apiKey: value, baseURL, from };
  }
  return null;
}

/** True when a key or token is set somewhere Necromancer looks, so a call is worth attempting. */
export function hasCredentials(env: NodeJS.ProcessEnv = process.env, file: Record<string, string> = fileSettings()): boolean {
  return findCredentials(env, file) !== null;
}

/** How to give Necromancer a key. Shared by every message about a missing or rejected key. */
export function credentialsHint(): string {
  return (
    'run /plugin configure necromancer@legacy-necromancer in Claude Code, put ANTHROPIC_API_KEY=... in ~/.necromancer/.env, ' +
    `or set one of ${KEY_VARIABLES.join(', ')} (https://platform.claude.com/settings/keys)`
  );
}

function createClient(credentials: Credentials | null): Anthropic {
  if (!credentials) throw new LlmError('credentials', `no Anthropic API key: ${credentialsHint()}`);
  const { apiKey, authToken, baseURL } = credentials;
  return new Anthropic(apiKey ? { apiKey, baseURL } : { authToken, baseURL });
}

function translate(err: unknown, credentials: Credentials | null = null): LlmError {
  if (err instanceof LlmError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    const which = credentials ? `the key from ${credentials.from}` : 'the key';
    return new LlmError('credentials', `the Anthropic API rejected ${which}. To change it, ${credentialsHint()} (${detail})`, { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate_limit', `rate limited; try again shortly (${detail})`, { cause: err });
  if (err instanceof Anthropic.InternalServerError) return new LlmError('overloaded', `the API is overloaded or failing (${detail})`, { cause: err });
  if (err instanceof Anthropic.APIError) return new LlmError('api', detail, { cause: err });
  // The SDK throws a plain Error when it can't find any credentials.
  if (/api[_ ]?key|auth/i.test(detail)) return new LlmError('credentials', `no usable Anthropic API key: ${credentialsHint()} (${detail})`, { cause: err });
  return new LlmError('api', detail, { cause: err });
}

/**
 * A model that replays canned answers, for tests and offline runs. Each answer is validated against the
 * request's schema, so a fixture that drifts from the schema fails loudly.
 */
export class ScriptedModel implements StructuredModel {
  readonly name = 'scripted';
  readonly requests: Array<StructuredRequest<unknown>> = [];
  private readonly answers: Array<unknown | ((request: StructuredRequest<unknown>) => unknown)>;

  constructor(...answers: Array<unknown | ((request: StructuredRequest<unknown>) => unknown)>) {
    this.answers = answers;
  }

  async generate<T>(request: StructuredRequest<T>): Promise<StructuredResult<T>> {
    this.requests.push(request as StructuredRequest<unknown>);
    if (!this.answers.length) throw new LlmError('api', 'ScriptedModel ran out of answers');
    const next = this.answers.shift();
    const raw = typeof next === 'function' ? (next as (r: StructuredRequest<unknown>) => unknown)(request as StructuredRequest<unknown>) : next;
    if (raw instanceof Error) throw raw;
    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) throw new LlmError('unparsed', `scripted answer does not match the schema: ${parsed.error.message}`);
    return { output: parsed.data, model: this.name, fellBack: false, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
