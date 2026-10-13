/**
 * 留存 GC 不得用 `.returning()` 计数（#481）。
 *
 * 返回结果相同、行为测试分辨不出：区别只在于每一条被删 / 被改的行 id 是否回传进 Worker 内存。
 * 历史积压上百万行时这足以 OOM，且失败后下次 cron 重试同一批、永远清不完。
 * 删除行为本身由真 Postgres 集成测试覆盖（execution-retention-gc.saas.integration.test.ts）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('execution-retention-gc', () => {
  it('★不调用 .returning()，计数取驱动返回的受影响行数', () => {
    const src = readFileSync(join(process.cwd(), 'src/lib/retention/execution-retention-gc.ts'), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/\.returning\s*\(/);
    expect(code).toMatch(/affectedRows\(\s*await db\.delete\(/);
    expect(code).toMatch(/affectedRows\(\s*await db\.update\(/);
  });
});

describe('nonce-service', () => {
  it('★回收不调用 .returning()，计数取驱动返回的受影响行数（#480，同 #481）', () => {
    const src = readFileSync(join(process.cwd(), 'src/services/security/nonce-service.ts'), 'utf-8');
    const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(code).not.toMatch(/\.returning\s*\(/);
    expect(code).toMatch(/affectedRows\(\s*await db\.delete\(usedNonces\)/);
  });
});
