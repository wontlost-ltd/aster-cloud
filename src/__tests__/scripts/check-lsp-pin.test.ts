/**
 * Guard test (GitHub #98): the standalone LSP image (lsp-package.json) must pin
 * the exact same @aster-cloud/aster-lang-ts version as the app (package.json),
 * so the deployed language server runs the same compiler build as the app.
 *
 * Mirrors scripts/check-lsp-pin.mjs (also wired into CI) as a fast unit guard.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..', '..');
const DEP = '@aster-cloud/aster-lang-ts';

function read(file: string): Record<string, Record<string, string>> {
  return JSON.parse(readFileSync(join(ROOT, file), 'utf-8'));
}

describe('LSP compiler pin parity', () => {
  it('lsp-package.json pins the same aster-lang-ts version as package.json', () => {
    const appPin = read('package.json').dependencies?.[DEP];
    const lspPin = read('lsp-package.json').dependencies?.[DEP];
    expect(appPin).toBeTruthy();
    expect(lspPin).toBe(appPin);
  });
});
