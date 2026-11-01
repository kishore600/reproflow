import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { 'cli/index': 'src/cli/index.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  banner: { js: '#!/usr/bin/env node' },
});
