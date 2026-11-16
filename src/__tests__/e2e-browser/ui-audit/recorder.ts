/**
 * UI 审计（#774）结果落盘：发现项、链接、覆盖记录各写一份 JSONL（多 worker 并发追加，单行写入足够小、不会交错）。
 * 汇总报告由 scripts/ui-audit/report.ts 读取这些文件生成。
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export type Severity = 'critical' | 'serious' | 'moderate' | 'minor';

export interface AuditContext {
  route: string;
  path: string;
  role: string;
  locale: string;
  viewport: 'desktop' | 'mobile';
  theme?: 'light' | 'dark';
}

export interface Finding extends AuditContext {
  severity: Severity;
  category: string;
  message: string;
  detail?: string;
  screenshot?: string;
}

export const OUT_DIR = process.env.UI_AUDIT_OUT || join(process.cwd(), 'test-results/ui-audit');

function append(file: string, row: unknown): void {
  mkdirSync(OUT_DIR, { recursive: true });
  appendFileSync(join(OUT_DIR, file), `${JSON.stringify(row)}\n`);
}

export const recordFinding = (f: Finding): void => append('findings.jsonl', f);
export const recordCoverage = (row: AuditContext & { status: number; finalUrl: string; ms: number; checks: string[] }): void =>
  append('coverage.jsonl', row);
export const recordLinks = (row: AuditContext & { links: Array<{ url: string; text: string }> }): void => append('links.jsonl', row);

export function screenshotPath(ctx: AuditContext, theme: 'light' | 'dark'): string {
  const slug = (ctx.path || 'home').replace(/[^a-zA-Z0-9-]+/g, '_');
  return join(OUT_DIR, 'screens', ctx.viewport, ctx.locale, theme, `${slug}__${ctx.role}.png`);
}
