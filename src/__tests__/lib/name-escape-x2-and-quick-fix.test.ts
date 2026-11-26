// ADR 0060 修订 2 X2（#857）：cloud 别名与内嵌词汇保存校验拒绝 U+0060；ADR 0058 修订 3 E2：「用作名字」快速修复受开关控制。
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/prisma', () => ({ structuralAliasGrants: {} }));
vi.mock('@/db/fresh-read', () => ({ freshDb: {} }));

import { formatAliasIssueZh, validateUserAliases } from '@/lib/policy-alias-shared';
import { buildAliasReservedFromVocabulary } from '@/lib/structural-alias-grants';
import { EmbeddedVocabularyError, validateEmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';
import { codeActionMarkers, NAME_ESCAPE_FIX_CODES } from '@/hooks/useAsterLSP';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

describe('X2：别名不得含反引号（containsBacktick）', () => {
  const reserved = buildAliasReservedFromVocabulary('zh-CN', null);

  it('前置失败：只报 containsBacktick，不再叠加 singleWord / shadowsKeyword 等', () => {
    const zh = validateUserAliases({ RETURN: ['`低头`'] }, reserved, { allowStructural: true, locale: 'zh-CN' });
    expect(zh.valid).toBe(false);
    expect(zh.issues).toEqual([{ code: 'containsBacktick', kind: 'RETURN', alias: '`低头`' }]);
    expect(zh.errors).toEqual(["别名 '`低头`'（RETURN）含反引号 `，与名字转义冲突，禁止"]);

    const en = validateUserAliases({ TIMES: ['multiplied `by`'] }, buildAliasReservedFromVocabulary('en-US', null), { locale: 'en-US' });
    expect(en.issues.map((i) => i.code)).toEqual(['containsBacktick']);
  });

  it('非规范形先于反引号检查（与 ts / core 同序）；全角 ｀ 不在此列', () => {
    const r = validateUserAliases({ TIMES: [' `by` x'] }, reserved, { locale: 'en-US' });
    expect(r.issues.map((i) => i.code)).toEqual(['nonCanonical']);
    const fullWidth = validateUserAliases({ TIMES: ['乘 ｀以'] }, reserved, { locale: 'zh-CN' });
    expect(fullWidth.issues.map((i) => i.code)).not.toContain('containsBacktick');
  });

  it('四种界面语言都有 containsBacktick 文案', () => {
    for (const locale of ['en', 'zh', 'de', 'hi'] as const) {
      const errors = (DEMO_SUPPLEMENT[locale] as { policies: { form: { aliases: { errors: Record<string, string> } } } })
        .policies.form.aliases.errors;
      expect(errors.containsBacktick, locale).toContain('{alias}');
      expect(errors.containsBacktick, locale).toContain('{kind}');
    }
    expect(formatAliasIssueZh({ code: 'containsBacktick', kind: 'TIMES', alias: 'a`b' })).toContain('反引号');
  });
});

describe('X2：内嵌词汇写法不得含反引号', () => {
  const save = (localized: string, kind: 'struct' | 'literal' = 'struct', canonical = 'Driver') => () =>
    validateEmbeddedVocabulary({ v: 1, terms: [{ kind, localized, canonical }] }, { locale: 'zh-CN', aliasSet: null });

  it('写法含反引号 → embedded_vocabulary_invalid（引擎 validateVocabulary 判定），文案提到反引号', () => {
    expect(save('`司机`')).toThrow(EmbeddedVocabularyError);
    expect(save('`司机`')).toThrow(expect.objectContaining({ code: 'embedded_vocabulary_invalid' }));
    for (const locale of ['en', 'zh', 'de', 'hi'] as const) {
      const terms = (DEMO_SUPPLEMENT[locale] as { policyEditor: { embeddedTerms: { errors: Record<string, string> } } })
        .policyEditor.embeddedTerms.errors;
      expect(terms.embedded_vocabulary_invalid, locale).toContain('`');
    }
  });

  it('字面量宏的值可以含反引号（它展开在字符串里）', () => {
    expect(save('问候', 'literal', 'say `hi`')).not.toThrow();
  });
});

describe('E2：「用作名字」快速修复随开关', () => {
  const markers = [
    { code: 'E901', message: 'keyword as name' },
    { code: { value: 'W802' }, message: 'renamed' },
    { code: 'E808', message: 'alias as name' },
    { code: 'E200', message: 'missing effect' },
    { message: 'no code' },
  ];

  it('开关关闭：E901 / W802 / E808 不发给服务端，其余照旧', () => {
    expect(codeActionMarkers(markers, false).map((m) => m.message)).toEqual(['missing effect', 'no code']);
  });

  it('开关打开：全部照发', () => {
    expect(codeActionMarkers(markers, true)).toEqual(markers);
    expect([...NAME_ESCAPE_FIX_CODES].sort()).toEqual(['E808', 'E901', 'W802']);
  });
});
