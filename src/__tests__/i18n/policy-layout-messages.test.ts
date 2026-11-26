// 显示排版只读视图的文案（ADR 0058 P2 T7/T8）：四种语言都存在且非空，占位符一致。
import { describe, expect, it } from 'vitest';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

const KEYS = [
  'tabsLabel', 'tabCanonical', 'tabDisplay', 'displayLabel', 'displayNote', 'insertionLabel', 'hiddenEscapeLabel',
  'inconsistent', 'compareChanged', 'compareNote', 'reviewNote', 'reviewLink',
] as const;

describe('policyLayout 文案', () => {
  it.each(['en', 'zh', 'de', 'hi'] as const)('%s：全部键存在且非空', (locale) => {
    const messages = (DEMO_SUPPLEMENT[locale] as Record<string, Record<string, unknown>>).policyLayout;
    expect(Object.keys(messages).sort()).toEqual([...KEYS].sort());
    for (const key of KEYS) {
      expect(typeof messages[key] === 'string' && (messages[key] as string).trim().length > 0, `${locale}.${key}`).toBe(true);
    }
    expect(messages.insertionLabel).toContain('{canonical}');
    expect(messages.hiddenEscapeLabel).toContain('{canonical}');
  });
});
