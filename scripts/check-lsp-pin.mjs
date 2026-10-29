/**
 * check-lsp-pin.mjs
 *
 * Guard: the standalone LSP microservice (lsp-package.json) MUST pin the same
 * @aster-cloud/aster-lang-ts version as the main app (package.json).
 *
 * Why: the deployed LSP server (Dockerfile.lsp installs from lsp-package.json)
 * spawns the compiler/language-server out of node_modules. If its pin drifts
 * from the app's, browsers get diagnostics/completions from a STALE compiler
 * while the app renders/evaluates with a newer one — silent semantic skew.
 * (GitHub #98: lsp-package.json was pinned 4 majors behind at ^0.2.0 vs 1.0.1.)
 *
 * The app pin is treated as the source of truth. We compare the EXACT strings
 * so the LSP image resolves a deterministic, identical compiler build.
 *
 * Exit codes:
 *   0 = pins match
 *   1 = drift (or a file/field is missing/malformed)
 *
 * Usage:
 *   node scripts/check-lsp-pin.mjs
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..');

const DEP = '@aster-cloud/aster-lang-ts';

function readPin(file, section) {
  let json;
  try {
    json = JSON.parse(readFileSync(join(PROJECT_ROOT, file), 'utf-8'));
  } catch (e) {
    console.error(`✗ failed to read/parse ${file}: ${e.message}`);
    process.exit(1);
  }
  const pin = json?.[section]?.[DEP];
  if (typeof pin !== 'string') {
    console.error(`✗ ${file} has no ${section}["${DEP}"] string`);
    process.exit(1);
  }
  return pin;
}

const appPin = readPin('package.json', 'dependencies');
const lspPin = readPin('lsp-package.json', 'dependencies');

if (appPin !== lspPin) {
  console.error(
    `✗ LSP compiler pin drift: lsp-package.json pins ${DEP}@${lspPin} ` +
      `but package.json pins ${DEP}@${appPin}.\n` +
      `  Update lsp-package.json to the exact app pin (${appPin}) so the ` +
      `deployed LSP runs the same compiler build as the app.`,
  );
  process.exit(1);
}

console.log(`✓ LSP compiler pin matches app pin: ${DEP}@${appPin}`);
