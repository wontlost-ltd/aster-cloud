import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { defaultControlRegistry } from '@/services/evidence/control-registry';

describe('controls 副本', () => {
  const source = join(process.cwd(), '..', 'aster-lang-locales', 'controls', 'registry.json');
  it.skipIf(!existsSync(source))('与 aster-lang-locales 真相源深度相等', () => {
    expect(defaultControlRegistry).toEqual(JSON.parse(readFileSync(source, 'utf8')));
  });
});
