/*
 * 管理员概览卡文案形状：页面按 `${cardKey}.title/.description/.cta` 动态取键，
 * check-message-keys 只能解析字面量 key，看不见这种用法；曾因把卡片写成单个字符串
 * 而在页面上直接显示 key 路径。这里锁住补充层里每个 locale 的概览卡都是三键对象。
 */
import { describe, it, expect } from 'vitest';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { locales } from '@/i18n/config';

const SUPPLEMENT_CARDS = ['aiWorkspaceAccessCard', 'revalidationCard'] as const;

describe('admin.overview.*Card（本地补充层）', () => {
  it.each(locales)('%s：每张卡都有非空的 title / description / cta', (locale) => {
    const admin = DEMO_SUPPLEMENT[locale].admin as { overview?: Record<string, unknown> };
    for (const card of SUPPLEMENT_CARDS) {
      const value = admin.overview?.[card] as Record<string, unknown> | undefined;
      expect(value, `${locale}.admin.overview.${card}`).toBeTypeOf('object');
      for (const field of ['title', 'description', 'cta'] as const) {
        expect(value?.[field], `${locale}.admin.overview.${card}.${field}`).toBeTypeOf('string');
        expect((value?.[field] as string).length).toBeGreaterThan(0);
      }
    }
  });
});
