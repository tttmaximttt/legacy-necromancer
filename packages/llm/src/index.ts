import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
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
  /** Injected in tests or to point at a proxy; defaults to `new Anthropic()`, which reads ANTHROPIC_API_KEY. */
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
    const client = this.client ?? createClient();
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
      throw translate(err);
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

function createClient(): Anthropic {
  try {
    return new Anthropic();
  } catch (err) {
    throw translate(err);
  }
}

export function credentialsHint(): string {
  return 'no Anthropic credentials: set ANTHROPIC_API_KEY (https://platform.claude.com/settings/keys)';
}

/** True when an API key or token is in the environment, so a call is worth attempting. */
export function hasCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
}

function translate(err: unknown): LlmError {
  if (err instanceof LlmError) return err;
  const detail = err instanceof Error ? err.message : String(err);
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return new LlmError('credentials', `${credentialsHint()} (${detail})`, { cause: err });
  }
  if (err instanceof Anthropic.RateLimitError) return new LlmError('rate_limit', `rate limited; try again shortly (${detail})`, { cause: err });
  if (err instanceof Anthropic.InternalServerError) return new LlmError('overloaded', `the API is overloaded or failing (${detail})`, { cause: err });
  if (err instanceof Anthropic.APIError) return new LlmError('api', detail, { cause: err });
  // The SDK throws a plain Error when it can't find any credentials.
  if (/api[_ ]?key|auth/i.test(detail)) return new LlmError('credentials', `${credentialsHint()} (${detail})`, { cause: err });
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
