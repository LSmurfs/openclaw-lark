import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('plugin manifest', () => {
  it('declares the diagnostic CLI command for runtime-free discovery', () => {
    const manifest = JSON.parse(readFileSync(new URL('../openclaw.plugin.json', import.meta.url), 'utf8'));
    expect(manifest.cliCommands).toEqual([
      {
        name: 'feishu-diagnose',
        description: 'Run Feishu plugin diagnostics',
        hasSubcommands: false,
      },
    ]);
  });
});
