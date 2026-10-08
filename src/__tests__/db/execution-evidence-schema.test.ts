// src/__tests__/db/execution-evidence-schema.test.ts
// ADR 0041 §4：决策五态（含 require_approval/escalate）与 Execution 可查证据列。
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { executionDecisionEnum, executions } from '@/db/schema';

describe('ADR 0041 execution evidence schema', () => {
  it('ExecutionDecision 六值且 Execution 有证据列', () => {
    expect(executionDecisionEnum.enumValues).toEqual(['approved', 'denied', 'indeterminate', 'error', 'require_approval', 'escalate']);
    const cols = getTableColumns(executions);
    for (const c of ['outcome', 'ruleId', 'controls', 'agent', 'evidenceCorrelationId']) {
      expect(cols[c as keyof typeof cols]).toBeDefined();
      expect(cols[c as keyof typeof cols].notNull).toBe(false);
    }
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string; when: number; idx: number }> };
    // 按 tag 定位而非取末项：后续迁移（如 0051）追加后本断言仍只钉 0050 自身的顺序
    const at = journal.entries.findIndex((e) => e.tag === '0050_execution_evidence');
    expect(at).toBeGreaterThan(0);
    const last = journal.entries[at];
    const prev = journal.entries[at - 1];
    expect(last.idx).toBe(prev.idx + 1);
    expect(last.when).toBeGreaterThan(prev.when);
    const sql = readFileSync('drizzle/0050_execution_evidence.sql', 'utf8');
    expect(sql).toContain(`ALTER TYPE "public"."ExecutionDecision" ADD VALUE IF NOT EXISTS 'require_approval'`);
    expect(sql).toContain(`ALTER TYPE "public"."ExecutionDecision" ADD VALUE IF NOT EXISTS 'escalate'`);
    expect(sql).toContain('ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "evidenceCorrelationId" text');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "Execution_evidenceCorrelationId_idx"');
  });

  // ADR 0042 §5.3：审批已决通知按 metadata->>'guardDecisionId' 反查执行行，须有表达式部分索引。
  it('迁移 0052 在 journal 中紧随 0051，并创建 guardDecisionId 表达式部分索引', () => {
    const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: Array<{ tag: string; when: number; idx: number }> };
    const at = journal.entries.findIndex((e) => e.tag === '0052_execution_guard_decision_idx');
    expect(at).toBeGreaterThan(0);
    const entry = journal.entries[at];
    const prev = journal.entries[at - 1];
    expect(entry).toEqual(expect.objectContaining({ idx: 52, when: 1789700000000 }));
    expect(prev.tag).toBe('0051_business_roles');
    expect(entry.when).toBeGreaterThan(prev.when);
    const sql = readFileSync('drizzle/0052_execution_guard_decision_idx.sql', 'utf8');
    expect(sql).toContain(
      `CREATE INDEX IF NOT EXISTS "Execution_guardDecisionId_idx" ON "Execution" ((metadata->>'guardDecisionId')) WHERE metadata->>'guardDecisionId' IS NOT NULL;`
    );
  });
});
