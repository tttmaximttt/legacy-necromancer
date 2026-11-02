#!/usr/bin/env node
import { loadSettings } from '@necromancer/core';
import { createProgram } from './index.js';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

try {
  loadSettings();
} catch (err) {
  process.stderr.write(`necromancer: ignoring settings file: ${message(err)}\n`);
}
createProgram()
  .parseAsync()
  .catch((err: unknown) => {
    process.stderr.write(`necromancer: ${message(err)}\n`);
    process.exit(1);
  });
