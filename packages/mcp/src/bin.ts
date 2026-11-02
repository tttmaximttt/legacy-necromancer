#!/usr/bin/env node
import { loadSettings } from '@necromancer/core';
import { runStdio } from './index.js';

try {
  loadSettings();
} catch (err) {
  process.stderr.write(`necromancer: ignoring settings file: ${err instanceof Error ? err.message : String(err)}\n`);
}
await runStdio({ workdir: process.env.NECROMANCER_WORKDIR });
