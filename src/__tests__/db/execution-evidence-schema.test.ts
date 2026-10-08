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
    const last = journal.entries.at(-1)!;
    const prev = journal.entries.at(-2)!;
    expect(last.tag).toBe('0050_execution_evidence');
    expect(last.idx).toBe(prev.idx + 1);
    expect(last.when).toBeGreaterThan(prev.when);
    const sql = readFileSync('drizzle/0050_execution_evidence.sql', 'utf8');
    expect(sql).toContain(`ALTER TYPE "public"."ExecutionDecision" ADD VALUE IF NOT EXISTS 'require_approval'`);
    expect(sql).toContain(`ALTER TYPE "public"."ExecutionDecision" ADD VALUE IF NOT EXISTS 'escalate'`);
    expect(sql).toContain('ALTER TABLE "Execution" ADD COLUMN IF NOT EXISTS "evidenceCorrelationId" text');
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS "Execution_evidenceCorrelationId_idx"');
  });
});
