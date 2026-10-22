import { describe, expect, it } from 'vitest';
import { AI_WORKSPACE_NEXT_PATTERN, aiWorkspaceOrigin, isAiWorkspaceEnabledFor, resolveAiWorkspaceBase } from '@/lib/ai-workspace';

// 工作台仅 SaaS 开放；on-prem project 下灰度判定恒为 false，肯定断言只在 saas 跑
const IS_SAAS_BUILD = (process.env.DEPLOYMENT_MODE ?? '') === 'saas';

describe('ai-workspace config', () => {
  it('解析合法 https 地址并去掉末尾斜杠', () => {
    expect(resolveAiWorkspaceBase('https://ai.aster-lang.cloud/')).toBe('https://ai.aster-lang.cloud');
    expect(aiWorkspaceOrigin('https://ai.aster-lang.cloud/x')).toBe('https://ai.aster-lang.cloud');
  });
  it('未设置或非法时返回 null（功能关闭）', () => {
    expect(resolveAiWorkspaceBase(undefined)).toBeNull();
    expect(resolveAiWorkspaceBase('not a url')).toBeNull();
    expect(aiWorkspaceOrigin('')).toBeNull();
  });
  it.runIf(IS_SAAS_BUILD)('灰度：all 对所有人开启；名单只对列出的用户开启；地址缺失一律关闭', () => {
    const base = 'https://ai.aster-lang.cloud';
    expect(isAiWorkspaceEnabledFor('u1', base, 'all')).toBe(true);
    expect(isAiWorkspaceEnabledFor('u1', base, 'u2, u1')).toBe(true);
    expect(isAiWorkspaceEnabledFor('u3', base, 'u2,u1')).toBe(false);
    expect(isAiWorkspaceEnabledFor('u1', base, '')).toBe(false);
    expect(isAiWorkspaceEnabledFor('u1', null, 'all')).toBe(false);
  });
  it.runIf(!IS_SAAS_BUILD)('非 SaaS 部署：即便 all 也一律关闭', () => {
    expect(isAiWorkspaceEnabledFor('u1', 'https://ai.aster-lang.cloud', 'all')).toBe(false);
  });
  it('next 只允许工作台根路径与带 policyId 的侧栏', () => {
    expect(AI_WORKSPACE_NEXT_PATTERN.test('/')).toBe(true);
    expect(AI_WORKSPACE_NEXT_PATTERN.test('/panel?policyId=abc-123')).toBe(true);
    expect(AI_WORKSPACE_NEXT_PATTERN.test('//evil.com')).toBe(false);
    expect(AI_WORKSPACE_NEXT_PATTERN.test('/panel?policyId=a&x=1')).toBe(false);
  });
});

describe('工作台主题参数（F29）', () => {
  it('只接受解析后的 dark/light', async () => {
    const { toWorkspaceTheme } = await import('@/lib/ai-workspace');
    expect(toWorkspaceTheme('dark')).toBe('dark');
    expect(toWorkspaceTheme('light')).toBe('light');
    expect(toWorkspaceTheme('system')).toBeNull();
    expect(toWorkspaceTheme(undefined)).toBeNull();
    expect(toWorkspaceTheme('<x>')).toBeNull();
  });

  it('交接地址带 next / locale / theme', async () => {
    const { aiWorkspaceHandoffSrc } = await import('@/lib/ai-workspace');
    const src = aiWorkspaceHandoffSrc({ next: '/panel?policyId=p1', locale: 'zh', theme: 'dark' });
    expect(src.startsWith('/api/ai-workspace/handoff?')).toBe(true);
    const params = new URLSearchParams(src.split('?').slice(1).join('?'));
    expect(params.get('next')).toBe('/panel?policyId=p1');
    expect(params.get('locale')).toBe('zh');
    expect(params.get('theme')).toBe('dark');
  });
});
