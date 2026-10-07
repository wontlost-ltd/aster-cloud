// src/__tests__/db/api-key-team-scope-schema.test.ts
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { apiKeys, apiCallRecords } from '@/db/schema';

describe('ADR 0015 schema', () => {
  it('ApiKey 有可空 teamId 列', () => {
    const col = getTableColumns(apiKeys).teamId;
    expect(col).toBeDefined();
    expect(col.notNull).toBe(false);
  });
  it('ApiCallRecord 有可空 quotaOwnerId 列', () => {
    const col = getTableColumns(apiCallRecords).quotaOwnerId;
    expect(col).toBeDefined();
    expect(col.notNull).toBe(false);
  });
  it('迁移 0049 已登记且 when 单调', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string; when: number }> };
    const last = journal.entries[journal.entries.length - 1];
    expect(last.tag).toBe('0049_api_key_team_scope');
    expect(last.when).toBeGreaterThan(1789342699256);
    const sql = readFileSync('drizzle/0049_api_key_team_scope.sql', 'utf8');
    expect(sql).toContain('ALTER TABLE "ApiKey" ADD COLUMN IF NOT EXISTS "teamId" text');
    expect(sql).toContain('ALTER TABLE "ApiCallRecord" ADD COLUMN IF NOT EXISTS "quotaOwnerId" text');
  });
});
