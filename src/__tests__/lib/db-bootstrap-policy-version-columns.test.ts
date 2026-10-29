// 冷启动补列：迁移 0060 未执行时，PolicyVersion 的整行查询会选 sourceScopesJson 而 500，
// 冷启动补丁须先幂等补上该列（ADR 0051 §7）。
import { describe, it, expect, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async () => ({ rows: [] })) }));

vi.mock('@/db', () => ({
  getDb: () => ({ execute }),
  hasDbBinding: () => true,
}));

import { ensureSchemaApplied } from '@/lib/db-bootstrap';

describe('db-bootstrap — PolicyVersion 列补丁', () => {
  it('幂等补上 sourceScopesJson 列', async () => {
    await ensureSchemaApplied();
    const dialect = new PgDialect();
    const statements = execute.mock.calls.map((call) =>
      dialect.sqlToQuery((call as unknown as [SQL])[0]).sql.replace(/\s+/g, ' ').trim(),
    );
    expect(statements).toContain('ALTER TABLE "PolicyVersion" ADD COLUMN IF NOT EXISTS "sourceScopesJson" text');
  });
});
