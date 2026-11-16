/**
 * UI 审计（#774）路由清单守卫：src/app/[locale] 下每个 page.tsx 都必须登记在审计清单里，
 * 新增页面忘记登记时这里失败，保证 `pnpm test:ui-audit` 的覆盖不悄悄缩水。
 */
import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildRoleSweep, buildRoutes, localePath } from './e2e-browser/ui-audit/routes';

const APP_LOCALE = join(process.cwd(), 'src/app/[locale]');

function pagePatterns(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pagePatterns(full));
    else if (name === 'page.tsx') out.push(relative(APP_LOCALE, dir).split(sep).join('/'));
  }
  return out;
}

const fixtures = { personalPolicyId: 'p1', teamPolicyId: 'p2', teamId: 't1' };

describe('ui-audit route inventory', () => {
  it('lists every page.tsx under src/app/[locale]', () => {
    const listed = new Set(buildRoutes(fixtures).map((r) => r.pattern));
    const missing = pagePatterns(APP_LOCALE).filter((p) => !listed.has(p)).sort();
    expect(missing).toEqual([]);
  });

  it('does not list routes that no longer exist', () => {
    const pages = new Set(pagePatterns(APP_LOCALE));
    const stale = buildRoutes(fixtures).map((r) => r.pattern).filter((p) => !pages.has(p));
    expect(stale).toEqual([]);
  });

  it('fills dynamic segments from the seeded fixtures', () => {
    const paths = buildRoutes(fixtures).map((r) => r.path);
    expect(paths).toContain('policies/p1/logs');
    expect(paths).toContain('teams/t1/members');
    expect(paths.some((p) => p.includes('['))).toBe(false);
  });

  it('sweeps the shell pages for every non-primary role', () => {
    const roles = new Set(buildRoleSweep().map((r) => r.role));
    expect(Array.from(roles).sort()).toEqual(['ui-free', 'ui-member', 'ui-owner', 'ui-platform', 'ui-teamadmin']);
  });

  it('builds locale-prefixed paths', () => {
    expect(localePath('zh', '')).toBe('/zh');
    expect(localePath('en', 'docs/api')).toBe('/en/docs/api');
  });
});
