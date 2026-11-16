#!/usr/bin/env node
/**
 * UI 审计（#774）一键运行：页面用例（桌面 + 移动）→ 链接校验 → 生成 Markdown 报告。
 * 页面用例的失败不阻断后两步；退出码取三步中的最大值。
 *
 * 前置：本地栈已启动且已执行 scripts/ui-audit/seed.ts；BASE_CLOUD 指向它。附加参数原样传给 Playwright。
 * 每次运行前清空 UI_AUDIT_OUT（默认 test-results/ui-audit），避免混入上一轮的发现项。
 */
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const out = process.env.UI_AUDIT_OUT || join(process.cwd(), 'test-results/ui-audit');
const extra = process.argv.slice(2);
rmSync(out, { recursive: true, force: true });

const run = (args) => spawnSync('pnpm', ['exec', ...args], { stdio: 'inherit', env: { ...process.env, UI_AUDIT_OUT: out } }).status ?? 1;

const pages = run(['playwright', 'test', '--project=ui-audit-desktop', '--project=ui-audit-mobile', ...extra]);
const links = run(['playwright', 'test', '--project=ui-audit-links']);
const report = run(['tsx', 'scripts/ui-audit/report.ts']);
process.exit(Math.max(pages, links, report));
