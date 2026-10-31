import type { HttpRoute, InterviewReport, WitnessCase } from '@necromancer/core';
import type { StructuredModel } from '@necromancer/llm';
import { z } from 'zod';

const CaseSchema = z.object({
  route: z.string().describe('The route this exercises, exactly as listed, e.g. "GET /users/:id"'),
  name: z.string().describe('Short description, e.g. "existing user" or "missing id"'),
  method: z.string(),
  path: z.string().describe('Concrete path with parameters filled in, plus any query string'),
  headers: z.array(z.object({ name: z.string(), value: z.string() })),
  body: z.string().nullable().describe('Request body as sent, usually JSON; null for none'),
});

export const CasesSchema = z.object({ cases: z.array(CaseSchema) });

export const INPUTS_SYSTEM_PROMPT = `You write HTTP requests that exercise a revived legacy Node.js app, so its current behaviour can be recorded as golden snapshots before anyone upgrades it.

For each route, write one to three requests: the normal case first, then the most telling edge case (missing or invalid input, unknown id). Read the handler code you are given and send what it actually reads: the body fields, query parameters and headers it uses, with plausible values. Fill path parameters with values that could exist, e.g. ids returned by a create route you also call; order matters, requests run in the order you list them. The app starts with an empty database.

Never send credentials you were not given; if a route needs auth, send the request without it and let the snapshot record the 401. Keep bodies small.`;

/** Without a model: one request per route, parameters filled with placeholders, JSON bodies empty. */
export function defaultCases(routes: HttpRoute[]): WitnessCase[] {
  return routes.map((r): WitnessCase => {
    const method = r.method === 'ALL' ? 'GET' : r.method;
    const hasBody = ['POST', 'PUT', 'PATCH'].includes(method);
    return {
      route: `${r.method} ${r.path}`,
      name: 'default',
      method,
      path: fillPath(r.path),
      headers: hasBody ? { 'content-type': 'application/json' } : {},
      body: hasBody ? '{}' : null,
    };
  });
}

/** `/users/:id/{post}/*` → `/users/1/1/x`. */
export function fillPath(pattern: string): string {
  return pattern
    .replace(/:(\w+)(\([^)]*\))?\??/g, '1')
    .replace(/\{[^}]+\}/g, '1')
    .replace(/\*/g, 'x');
}

export interface InputOptions {
  model: StructuredModel;
  routes: HttpRoute[];
  /** Handler source around each route's line, keyed by "file:line". */
  snippets: Map<string, string>;
  interview?: InterviewReport | null;
}

export async function generateCases({ model, routes, snippets, interview }: InputOptions): Promise<{ cases: WitnessCase[]; tokens: number }> {
  const listed = routes.map((r) => `${r.method} ${r.path}`);
  const code = routes
    .map((r) => {
      const snippet = snippets.get(`${r.file}:${r.line}`);
      return snippet ? `<handler route="${r.method} ${r.path}" file="${r.file}" line="${r.line}">\n${snippet}\n</handler>` : null;
    })
    .filter(Boolean);
  const prompt = [
    interview ? `What the app is for: ${interview.intent}\n` : '',
    `Routes, in the order they were found:\n${listed.join('\n')}`,
    `\n${code.join('\n\n')}`,
  ].join('\n');
  const result = await model.generate({ system: INPUTS_SYSTEM_PROMPT, prompt, schema: CasesSchema, effort: 'low', maxTokens: 16_000 });
  const known = new Set(listed);
  const cases: WitnessCase[] = result.output.cases
    .filter((c) => known.has(c.route) && c.path.startsWith('/'))
    .map((c) => ({
      route: c.route,
      name: c.name,
      method: c.method.toUpperCase(),
      path: c.path,
      headers: Object.fromEntries(c.headers.filter((h) => !/^(authorization|cookie)$/i.test(h.name)).map((h) => [h.name.toLowerCase(), h.value])),
      body: c.body,
    }));
  // Routes the model skipped still get the default request.
  const covered = new Set(cases.map((c) => c.route));
  const missing = defaultCases(routes.filter((r) => !covered.has(`${r.method} ${r.path}`)));
  return { cases: [...cases, ...missing], tokens: result.usage.inputTokens + result.usage.outputTokens };
}
