import { describe, expect, it } from 'vitest';
import { guardianEmbedUrl } from '@/components/marketing/guardian-embed';

describe('guardianEmbedUrl', () => {
  it('locale 进路径、theme 进查询参数', () => {
    expect(guardianEmbedUrl('zh', 'dark', 'https://aster-lang.dev/embed/guardian')).toBe('https://aster-lang.dev/embed/guardian/zh?theme=dark');
  });
  it('未知 locale 回退 en；去掉 base 末尾斜杠', () => {
    expect(guardianEmbedUrl('fr', 'light', 'https://x.test/embed/guardian/')).toBe('https://x.test/embed/guardian/en?theme=light');
  });
});
