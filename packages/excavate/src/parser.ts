import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { ImportKind, RawImport, RawMount, RawRoute, SourceLanguage } from '@necromancer/core';

const require = createRequire(import.meta.url);

const GRAMMARS: Record<SourceLanguage, string> = {
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
};

/**
 * The published npm bundle ships the grammar .wasm files in `grammars/` next to itself, so the tree-sitter
 * grammar packages (which carry node-gyp install scripts) need not be installed; in the workspace they resolve
 * from node_modules.
 */
function grammarPath(lang: SourceLanguage): string {
  const bundled = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grammars', path.basename(GRAMMARS[lang]));
  return existsSync(bundled) ? bundled : require.resolve(GRAMMARS[lang]);
}

const EXTENSIONS: Record<string, SourceLanguage> = {
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
};

export const SOURCE_EXTENSIONS = Object.keys(EXTENSIONS);

export function languageFor(file: string): SourceLanguage | null {
  const dot = file.lastIndexOf('.');
  if (dot === -1) return null;
  // `.d.ts` files carry types only; they never contribute runtime structure.
  if (/\.d\.[cm]?ts$/.test(file)) return null;
  return EXTENSIONS[file.slice(dot)] ?? null;
}

export interface ParsedSource {
  imports: RawImport[];
  parseErrors: number;
  routes: RawRoute[];
  mounts: RawMount[];
}

/** Loads the tree-sitter grammars once and extracts imports from source text. */
export class ImportParser {
  private constructor(private readonly parsers: Record<SourceLanguage, Parser>) {}

  static async create(): Promise<ImportParser> {
    await Parser.init();
    const entries = await Promise.all(
      (Object.keys(GRAMMARS) as SourceLanguage[]).map(async (lang) => {
        const parser = new Parser();
        parser.setLanguage(await Language.load(grammarPath(lang)));
        return [lang, parser] as const;
      }),
    );
    return new ImportParser(Object.fromEntries(entries) as Record<SourceLanguage, Parser>);
  }

  parse(source: string, language: SourceLanguage): ParsedSource {
    const tree = this.parsers[language].parse(source);
    if (!tree) return { imports: [], parseErrors: 1, routes: [], mounts: [] };
    try {
      const imports: RawImport[] = [];
      const routes: Array<RawRoute & { receiver: string | null }> = [];
      const pendingMounts: Array<{ prefix: string; target: Node; line: number; receiver: string | null }> = [];
      /** Local names bound to a module: `const api = require('./api')`, `import api from './api'`. */
      const bindings = new Map<string, string>();
      let parseErrors = 0;
      walk(tree.rootNode, (node) => {
        if (node.isError || node.isMissing) parseErrors++;
        const found = importFrom(node);
        if (found) {
          imports.push(found);
          const name = boundName(node);
          if (name) bindings.set(name, found.specifier);
        }
        if (node.type === 'call_expression') routesFrom(node, routes, pendingMounts);
      });
      // A router defined in this file and mounted here (`const api = Router(); app.use('/api', api)`)
      // lends its prefix to everything registered on it.
      const localPrefix = new Map<string, string>();
      for (const m of pendingMounts) {
        if (m.target.type === 'identifier' && !bindings.has(m.target.text) && m.prefix) localPrefix.set(m.target.text, m.prefix);
      }
      const prefixOf = (receiver: string | null) => {
        let prefix = '';
        for (let r = receiver, hops = 0; r && localPrefix.has(r) && hops < 5; hops++) {
          prefix = joinRoute(localPrefix.get(r)!, prefix);
          r = pendingMounts.find((m) => m.target.type === 'identifier' && m.target.text === r)?.receiver ?? null;
        }
        return prefix;
      };
      const mounts: RawMount[] = [];
      for (const m of pendingMounts) {
        const specifier = m.target.type === 'identifier' ? bindings.get(m.target.text) : requiredSpecifier(m.target);
        if (specifier) mounts.push({ prefix: joinRoute(prefixOf(m.receiver), m.prefix), specifier, line: m.line });
      }
      return {
        imports,
        parseErrors,
        routes: routes.map(({ receiver, ...r }) => ({ ...r, path: joinRoute(prefixOf(receiver), r.path) })),
        mounts,
      };
    } finally {
      tree.delete();
    }
  }

  dispose(): void {
    for (const parser of Object.values(this.parsers)) parser.delete();
  }
}

function walk(root: Node, visit: (node: Node) => void): void {
  const cursor = root.walk();
  try {
    let descending = true;
    for (;;) {
      if (descending) {
        visit(cursor.currentNode);
        if (cursor.gotoFirstChild()) continue;
      }
      if (cursor.gotoNextSibling()) {
        descending = true;
        continue;
      }
      if (!cursor.gotoParent()) return;
      descending = false;
    }
  } finally {
    cursor.delete();
  }
}

function importFrom(node: Node): RawImport | null {
  switch (node.type) {
    case 'import_statement':
      return literal(node.childForFieldName('source'), 'import', node);
    case 'export_statement':
      // Only re-exports (`export ... from 'x'`) have a source.
      return literal(node.childForFieldName('source'), 'export-from', node);
    case 'import_require_clause':
      // TypeScript: `import fs = require('fs')`
      return literal(node.childForFieldName('source'), 'import-equals', node);
    case 'call_expression': {
      const callee = node.childForFieldName('function');
      const args = node.childForFieldName('arguments');
      if (!callee || !args) return null;
      const first = args.namedChildren[0] ?? null;
      if (callee.type === 'import') return literal(first, 'dynamic-import', node);
      if (callee.type === 'identifier' && callee.text === 'require' && args.namedChildCount === 1) {
        return literal(first, 'require', node);
      }
      return null;
    }
    default:
      return null;
  }
}

function literal(node: Node | null, kind: ImportKind, at: Node): RawImport | null {
  const specifier = stringValue(node);
  // Computed specifiers (`require(name)`) can't be resolved statically.
  if (!specifier) return null;
  return { specifier, kind, line: at.startPosition.row + 1 };
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'del', 'head', 'options', 'all']);

/** The name a require/import binds, when it binds exactly one: `const x = require('y')`, `import x from 'y'`. */
function boundName(node: Node): string | null {
  if (node.type === 'import_statement') {
    const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
    const first = clause?.namedChildren[0];
    return first?.type === 'identifier' ? first.text : null;
  }
  if (node.type === 'call_expression') {
    const decl = node.parent;
    if (decl?.type === 'variable_declarator' && decl.childForFieldName('value')?.id === node.id) {
      const name = decl.childForFieldName('name');
      return name?.type === 'identifier' ? name.text : null;
    }
  }
  return null;
}

function requiredSpecifier(node: Node): string | null {
  if (node.type !== 'call_expression') return null;
  const callee = node.childForFieldName('function');
  const arg = node.childForFieldName('arguments')?.namedChildren[0];
  if (callee?.text !== 'require' || arg?.type !== 'string') return null;
  return arg.text.slice(1, -1);
}

function stringValue(node: Node | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string') return node.text.slice(1, -1);
  if (node.type === 'template_string' && !node.namedChildren.some((c) => c?.type === 'template_substitution')) return node.text.slice(1, -1);
  return null;
}

function objectProps(node: Node): Map<string, Node> {
  const props = new Map<string, Node>();
  for (const pair of node.namedChildren) {
    if (pair?.type !== 'pair') continue;
    const key = pair.childForFieldName('key');
    const value = pair.childForFieldName('value');
    const name = key ? (stringValue(key) ?? key.text) : null;
    if (name && value) props.set(name, value);
  }
  return props;
}

/**
 * Express, Restify and Koa-router: `x.get('/p', h)`, `x.route('/p').get(h)`, `x.get({ path: '/p' }, h)`,
 * `router.get('name', '/p', h)`. Hapi: `server.route({ method, path })` or an array of those.
 * Mounts: `x.use('/prefix', router)`.
 */
function routesFrom(
  node: Node,
  routes: Array<RawRoute & { receiver: string | null }>,
  mounts: Array<{ prefix: string; target: Node; line: number; receiver: string | null }>,
): void {
  const callee = node.childForFieldName('function');
  const args = node.childForFieldName('arguments')?.namedChildren.filter((a): a is Node => a !== null) ?? [];
  if (callee?.type !== 'member_expression') return;
  const method = callee.childForFieldName('property')?.text ?? '';
  const object = callee.childForFieldName('object');
  const line = node.startPosition.row + 1;
  const receiver = receiverOf(node);
  const isPath = (p: string | null): p is string => p !== null && (p.startsWith('/') || p === '*');

  if (method === 'use' && args.length >= 1) {
    // `x.use(router)` mounts at the parent's own prefix; only bindings to repo files end up mattering.
    const prefix = args.length >= 2 ? stringValue(args[0]) : '';
    if (prefix === '' || isPath(prefix)) mounts.push({ prefix, target: args[args.length - 1]!, line, receiver });
    return;
  }
  if (method === 'route' && args.length === 1) {
    const list = args[0]!.type === 'array' ? args[0]!.namedChildren : [args[0]!];
    for (const item of list) {
      if (item?.type !== 'object') continue;
      const props = objectProps(item);
      const path = stringValue(props.get('path'));
      const verb = props.get('method');
      const verbs = verb?.type === 'array' ? verb.namedChildren.map((v) => stringValue(v)) : [stringValue(verb)];
      if (isPath(path)) for (const v of verbs) if (v) routes.push({ method: v.toUpperCase() === '*' ? 'ALL' : v.toUpperCase(), path, line, receiver });
    }
    return;
  }
  if (!HTTP_METHODS.has(method)) return;
  const verb = method === 'del' ? 'DELETE' : method.toUpperCase();
  // `x.route('/p').get(h)`: the path is on the chained call.
  // Walk down `.route('/p').get(a).post(b)` chains to the `.route()` call.
  let link: Node | null = object;
  while (link?.type === 'call_expression') {
    const inner = link.childForFieldName('function');
    if (inner?.type !== 'member_expression') break;
    const name = inner.childForFieldName('property')?.text ?? '';
    if (name === 'route') {
      const path = stringValue(link.childForFieldName('arguments')?.namedChildren[0]);
      if (isPath(path)) routes.push({ method: verb, path, line, receiver });
      return;
    }
    if (!HTTP_METHODS.has(name)) break;
    link = inner.childForFieldName('object');
  }
  // A handler is required, so `map.get('/x')` and `config.get('/x')` don't count.
  if (args.length < 2) return;
  let path = stringValue(args[0]);
  if (!isPath(path) && args[0]!.type === 'object') path = stringValue(objectProps(args[0]!).get('path'));
  if (!isPath(path) && args.length >= 3) path = stringValue(args[1]);
  if (isPath(path)) routes.push({ method: verb, path, line, receiver });
}

/**
 * The variable a route or mount is registered on: `api` in `api.get(…)`, and also in
 * `const api = Router().use(a).get(…)`.
 */
function receiverOf(call: Node): string | null {
  let object = call.childForFieldName('function')?.childForFieldName('object') ?? null;
  while (object?.type === 'call_expression') {
    const fn = object.childForFieldName('function');
    if (fn?.type !== 'member_expression') break;
    object = fn.childForFieldName('object');
  }
  if (object?.type === 'identifier') return object.text;
  let top: Node = call;
  while (top.parent && (top.parent.type === 'member_expression' || top.parent.type === 'call_expression')) top = top.parent;
  const decl = top.parent;
  const name = decl?.type === 'variable_declarator' ? decl.childForFieldName('name') : null;
  return name?.type === 'identifier' ? name.text : null;
}

export function joinRoute(prefix: string, path: string): string {
  if (!prefix || prefix === '/') return path || '/';
  if (path === '/' || path === '') return prefix.length > 1 ? prefix.replace(/\/$/, '') : prefix;
  if (path === '*') return `${prefix.replace(/\/$/, '')}/*`;
  return `${prefix.replace(/\/$/, '')}/${path.replace(/^\//, '')}`;
}
