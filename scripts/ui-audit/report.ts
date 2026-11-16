/**
 * UI 审计（#774）报告：把 findings.jsonl / coverage.jsonl 汇总成按严重度、路由分组的 Markdown。
 * 同一路由上同类发现（跨视口 / 语言 / 主题）合并为一条并列出出现的上下文。
 *
 * 用法：pnpm exec tsx scripts/ui-audit/report.ts   （UI_AUDIT_OUT 指定输入目录，UI_AUDIT_REPORT 指定输出文件）
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

type Severity = 'critical' | 'serious' | 'moderate' | 'minor';
interface Row {
  route: string; path: string; role: string; locale: string; viewport: string; theme?: string;
  severity: Severity; category: string; message: string; detail?: string;
}
interface Coverage { route: string; path: string; role: string; locale: string; viewport: string; status: number; checks: string[] }

const OUT = process.env.UI_AUDIT_OUT || join(process.cwd(), 'test-results/ui-audit');
const REPORT = process.env.UI_AUDIT_REPORT || join(OUT, 'report.md');
const ORDER: Severity[] = ['critical', 'serious', 'moderate', 'minor'];

const readJsonl = <T>(name: string): T[] => {
  const file = join(OUT, name);
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T) : [];
};

/** 去掉计数等随上下文变化的部分，便于跨视口合并 */
const normalize = (m: string): string => m.replace(/\(\d+ nodes?\)/, '').replace(/\b\d+(px)?\b/g, 'N').trim();

function main(): void {
  const findings = readJsonl<Row>('findings.jsonl');
  const coverage = readJsonl<Coverage>('coverage.jsonl');

  const groups = new Map<string, { first: Row; contexts: Set<string>; details: Set<string> }>();
  for (const f of findings) {
    const key = [f.severity, f.category, f.route, f.role, normalize(f.message)].join('|');
    const g = groups.get(key) ?? { first: f, contexts: new Set<string>(), details: new Set<string>() };
    g.contexts.add(`${f.viewport}/${f.locale}${f.theme ? `/${f.theme}` : ''}`);
    if (f.detail) g.details.add(f.detail);
    groups.set(key, g);
  }

  const lines: string[] = [];
  const patterns = new Set(coverage.map((c) => c.route));
  const byVp = (vp: string) => coverage.filter((c) => c.viewport === vp).length;
  lines.push('# UI audit report (#774)', '');
  lines.push(`Generated ${new Date().toISOString()} from \`${relative(process.cwd(), OUT) || OUT}\`.`, '');
  lines.push('## Coverage', '');
  lines.push(`- Route patterns audited: **${patterns.size}**`);
  lines.push(`- Page audits: **${coverage.length}** (desktop ${byVp('desktop')}, mobile ${byVp('mobile')})`);
  lines.push(`- Locales: ${Array.from(new Set(coverage.map((c) => c.locale))).join(', ')}; roles: ${Array.from(new Set(coverage.map((c) => c.role))).join(', ')}`);
  const buttons = coverage.flatMap((c) => c.checks).filter((c) => c.startsWith('buttons:')).reduce((n, c) => n + Number(c.split(':')[1]), 0);
  const popups = coverage.flatMap((c) => c.checks).filter((c) => c.startsWith('popups:')).reduce((n, c) => n + Number(c.split(':')[1]), 0);
  lines.push(`- Buttons click-probed: ${buttons}; popup triggers keyboard-probed: ${popups}`, '');

  lines.push('## Findings by severity', '', '| Severity | Distinct findings | Raw occurrences |', '| --- | --- | --- |');
  for (const s of ORDER) {
    lines.push(`| ${s} | ${Array.from(groups.values()).filter((g) => g.first.severity === s).length} | ${findings.filter((f) => f.severity === s).length} |`);
  }
  lines.push('');

  const byCat = new Map<string, number>();
  for (const g of groups.values()) byCat.set(`${g.first.severity} ${g.first.category}`, (byCat.get(`${g.first.severity} ${g.first.category}`) ?? 0) + 1);
  lines.push('### By category', '', '| Severity / category | Distinct |', '| --- | --- |');
  for (const [k, n] of Array.from(byCat).sort((a, b) => ORDER.indexOf(a[0].split(' ')[0] as Severity) - ORDER.indexOf(b[0].split(' ')[0] as Severity) || b[1] - a[1])) {
    lines.push(`| ${k} | ${n} |`);
  }
  lines.push('');

  for (const s of ORDER) {
    const list = Array.from(groups.values()).filter((g) => g.first.severity === s);
    if (!list.length) continue;
    lines.push(`## ${s[0].toUpperCase()}${s.slice(1)} (${list.length})`, '');
    const routes = new Map<string, typeof list>();
    for (const g of list) routes.set(`${g.first.route} (${g.first.role})`, [...(routes.get(`${g.first.route} (${g.first.role})`) ?? []), g]);
    for (const [route, items] of Array.from(routes).sort()) {
      lines.push(`### \`${route}\``, '');
      for (const g of items) {
        const f = g.first;
        lines.push(`- **${f.category}** — ${f.message}`);
        lines.push(`  - Contexts: ${Array.from(g.contexts).sort().join(', ')}`);
        const detail = Array.from(g.details)[0];
        if (detail) lines.push(`  - Detail: \`${detail.split('\n').slice(0, 4).join(' ⏎ ').replace(/`/g, "'")}\``);
        const vp = f.viewport === 'mobile' ? 'ui-audit-mobile' : 'ui-audit-desktop';
        lines.push(`  - Repro: open \`/${f.locale}/${f.path}\` as \`${f.role}\` at ${f.viewport}; or \`UI_AUDIT_ONLY='^${f.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$' pnpm exec playwright test --project=${vp}\``);
        const slug = (f.path || 'home').replace(/[^a-zA-Z0-9-]+/g, '_');
        lines.push(`  - Screenshot: \`screens/${f.viewport}/${f.locale}/${f.theme ?? 'light'}/${slug}__${f.role}.png\``);
      }
      lines.push('');
    }
  }
  writeFileSync(REPORT, `${lines.join('\n')}\n`);
  console.log(`[ui-audit] report: ${REPORT} (${findings.length} raw findings, ${groups.size} distinct)`);
}

main();
