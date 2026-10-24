import { describe, expect, it } from 'vitest';
import { checkMigrationSplit } from '../../../scripts/ci/check-migration-split.mjs';

describe('checkMigrationSplit', () => {
  it.each([
    { name: '仅迁移', files: ['drizzle/0001.sql'], labels: [], body: '', expected: { ok: true } },
    { name: '仅代码', files: ['src/lib/example.ts'], labels: [], body: '', expected: { ok: true } },
    { name: '迁移加 schema.ts', files: ['drizzle/0001.sql', 'src/db/schema.ts'], labels: [], body: '', expected: { ok: true } },
    { name: '迁移加测试', files: ['drizzle/0001.sql', 'src/__tests__/example.test.ts'], labels: [], body: '', expected: { ok: true } },
    { name: '业务代码未标记', files: ['drizzle/0001.sql', 'src/lib/example.ts'], labels: [], body: '', expected: { ok: false, reason: 'split-required' } },
    { name: '标记但无小节', files: ['drizzle/0001.sql', 'src/lib/example.ts'], labels: ['migration-and-code'], body: '', expected: { ok: false, reason: 'tolerance-section-missing' } },
    { name: '标记且有小节', files: ['drizzle/0001.sql', 'src/lib/example.ts'], labels: ['migration-and-code'], body: '## 迁移窗口容错\n说明', expected: { ok: true } },
  ])('$name', ({ files, labels, body, expected }) => {
    expect(checkMigrationSplit({ files, labels, body })).toEqual(expected);
  });
});
