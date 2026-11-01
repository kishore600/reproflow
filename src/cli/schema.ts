import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Command } from 'commander';
import { flowJsonSchema } from '../flows/schema.js';
import { runCommand } from './output.js';

/** Hidden: prints the flow JSON Schema, or writes it with --out (`npm run build` does this). */
export function registerSchema(program: Command): void {
  program
    .command('schema', { hidden: true })
    .option('--out <file>', 'write the schema to this file instead of stdout')
    .action((opts: { out?: string }) =>
      runCommand(async () => {
        const text = `${JSON.stringify(flowJsonSchema(), null, 2)}\n`;
        if (opts.out) {
          await mkdir(dirname(opts.out), { recursive: true });
          await writeFile(opts.out, text);
        } else {
          process.stdout.write(text);
        }
        return 0;
      }),
    );
}
