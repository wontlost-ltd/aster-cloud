import { describe, expect, it } from 'vitest';
import { guardianEmbedUrl } from '@/components/marketing/guardian-embed';
import { guardianTryItUrl, resolveGuardianEmbedBase } from '@/lib/guardian-embed';

describe('guardianEmbedUrl', () => {
  it('locale 进路径、theme 进查询参数', () => {
    expect(guardianEmbedUrl('zh', 'dark', 'https://aster-lang.dev/embed/guardian')).toBe('https://aster-lang.dev/embed/guardian/zh?theme=dark');
  });
  it('未知 locale 回退 en；去掉 base 末尾斜杠', () => {
    expect(guardianEmbedUrl('fr', 'light', 'https://x.test/embed/guardian/')).toBe('https://x.test/embed/guardian/en?theme=light');
  });
});

describe('guardianTryItUrl', () => {
  it('默认指向 aster-lang.dev 的演示页', () => {
    expect(guardianTryItUrl('zh', undefined)).toBe('https://aster-lang.dev/zh/demos/guardian');
  });
  it('跟随配置 base 的 origin；未知 locale 回退 en', () => {
    expect(guardianTryItUrl('fr', 'http://localhost:3210/embed/guardian')).toBe('http://localhost:3210/en/demos/guardian');
  });
  it('非法配置回退默认', () => {
    expect(guardianTryItUrl('de', 'nope')).toBe('https://aster-lang.dev/de/demos/guardian');
    expect(resolveGuardianEmbedBase('nope')).toBe('https://aster-lang.dev/embed/guardian');
  });
});
