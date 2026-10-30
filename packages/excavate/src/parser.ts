import { createRequire } from 'node:module';
import { Language, Parser, type Node } from 'web-tree-sitter';
import type { ImportKind, RawImport, SourceLanguage } from '@necromancer/core';

const require = createRequire(import.meta.url);

const GRAMMARS: Record<SourceLanguage, string> = {
  javascript: 'tree-sitter-javascript/tree-sitter-javascript.wasm',
  typescript: 'tree-sitter-typescript/tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-typescript/tree-sitter-tsx.wasm',
};

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
}

/** Loads the tree-sitter grammars once and extracts imports from source text. */
export class ImportParser {
  private constructor(private readonly parsers: Record<SourceLanguage, Parser>) {}

  static async create(): Promise<ImportParser> {
    await Parser.init();
    const entries = await Promise.all(
      (Object.keys(GRAMMARS) as SourceLanguage[]).map(async (lang) => {
        const parser = new Parser();
        parser.setLanguage(await Language.load(require.resolve(GRAMMARS[lang])));
        return [lang, parser] as const;
      }),
    );
    return new ImportParser(Object.fromEntries(entries) as Record<SourceLanguage, Parser>);
  }

  parse(source: string, language: SourceLanguage): ParsedSource {
    const tree = this.parsers[language].parse(source);
    if (!tree) return { imports: [], parseErrors: 1 };
    try {
      const imports: RawImport[] = [];
      let parseErrors = 0;
      walk(tree.rootNode, (node) => {
        if (node.isError || node.isMissing) parseErrors++;
        const found = importFrom(node);
        if (found) imports.push(found);
      });
      return { imports, parseErrors };
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
  if (!node) return null;
  let specifier: string | null = null;
  if (node.type === 'string') {
    specifier = node.text.slice(1, -1);
  } else if (node.type === 'template_string' && !node.namedChildren.some((c) => c?.type === 'template_substitution')) {
    specifier = node.text.slice(1, -1);
  }
  // Computed specifiers (`require(name)`) can't be resolved statically.
  if (!specifier) return null;
  return { specifier, kind, line: at.startPosition.row + 1 };
}
