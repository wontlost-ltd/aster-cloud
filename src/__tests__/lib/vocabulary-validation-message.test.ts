import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  IdentifierKind,
  validateVocabulary,
  type DomainVocabulary,
  type IdentifierMapping,
} from '@aster-cloud/aster-lang-ts/lexicons/identifiers/types';
import { validateDomainVocabulary } from '@/lib/domain-vocabulary-validation';
import { assembleDomainVocabularyFromLinks } from '@/lib/domain-vocabulary-assemble';
import { VOCAB_FORMAT_MESSAGES } from '@/lib/domain-vocabulary-format';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';
import {
  parseVocabularyValidationMessage,
  vocabularyValidationText,
  type VocabularyValidationTranslate,
} from '@/lib/vocabulary-validation-message';

/** 用真实引擎校验产出的消息（文案漂移时此测试会失败，提醒同步识别规则）。 */
function engineMessage(canonical: string): string {
  const vocab = assembleDomainVocabularyFromLinks(
    [{ domainTermId: 't1', domain: 'd', locale: 'de', kind: 'struct', canonical, localized: 'Fahrer', aliases: [] }],
    { domain: 'd', locale: 'de' },
  );
  const result = validateDomainVocabulary(vocab);
  expect(result.valid).toBe(false);
  return result.errors.join('; ');
}

const mapping = (kind: IdentifierKind, canonical: string, localized: string, extra: Partial<IdentifierMapping> = {}) =>
  ({ kind, canonical, localized, ...extra }) as IdentifierMapping;

function validate(parts: Partial<DomainVocabulary>) {
  return validateVocabulary({
    id: 'v', name: 'v', domain: 'd', locale: 'de-DE', version: '1',
    structs: [], fields: [], functions: [], enumValues: [], literals: [],
    ...parts,
  } as DomainVocabulary);
}

/**
 * 引擎（aster-lang-ts validateVocabulary）的每一种诊断形态（errors 与 warnings），全部取真实输出。
 * 服务端把 errors 以 "; " 拼接作为 validation_failed 的 message。
 */
const ENGINE_MESSAGES: Record<string, string> = {
  invalidCanonical: validate({ structs: [mapping(IdentifierKind.STRUCT, 'Bad Name!', 'Fahrer')] }).errors.join('; '),
  duplicateCanonical: validate({
    structs: [mapping(IdentifierKind.STRUCT, 'Driver', 'Fahrer'), mapping(IdentifierKind.STRUCT, 'Driver', 'Lenker')],
  }).errors.join('; '),
  duplicateLocalized: validate({
    structs: [mapping(IdentifierKind.STRUCT, 'Driver', 'Fahrer'), mapping(IdentifierKind.STRUCT, 'Rider', 'Fahrer')],
  }).warnings.join('; '),
  triggerConflict: validate({
    structs: [mapping(IdentifierKind.STRUCT, 'Driver', 'vip')],
    literals: [mapping(IdentifierKind.LITERAL, 'VIP customer', 'vip')],
  }).errors.join('; '),
  emptyLiteral: validate({ literals: [mapping(IdentifierKind.LITERAL, '', 'gruss')] }).errors.join('; '),
  controlLiteral: validate({ literals: [mapping(IdentifierKind.LITERAL, 'a\nb', 'gruss')] }).errors.join('; '),
  quotedLiteral: validate({ literals: [mapping(IdentifierKind.LITERAL, 'say "hi"', 'gruss')] }).errors.join('; '),
  fieldWithoutParent: validate({ fields: [mapping(IdentifierKind.FIELD, 'age', 'alter')] }).warnings.join('; '),
  registryWrapper: `词汇表 "d" 验证失败:\n${validate({ structs: [mapping(IdentifierKind.STRUCT, 'Bad Name!', 'Fahrer')] }).errors.join('\n')}`,
};

/** 服务层 / 路由 / 异步 worker 的英文 validation_failed 消息（src/lib/domain-vocabulary*.ts、api/v1/domain-vocabularies）。 */
const SERVER_MESSAGES = [
  'canonical is required',
  'localized is required',
  'domain and locale are required',
  'canonical and localized are required',
  'domain/locale/canonical/localized are required',
  'parentCanonical is required for kind=field',
  'terms[3].canonical is required',
  'terms[3].canonical must be a string',
  'aliases must be an array of strings',
  'terms[2].aliases must be an array of strings',
  'terms[1] must be an object',
  'row must be an object',
  'kind must be one of struct, field, function, enum_value',
  'terms[0].kind must be one of struct, field, function, enum_value',
  'kind must be struct|field|function|enum_value',
  VOCAB_FORMAT_MESSAGES.domain_format,
  VOCAB_FORMAT_MESSAGES.locale_format,
  'bulk import requires at least one term',
  'async bulk import requires at least one term',
  '"terms" must not be empty',
  '"terms" must be a non-empty array',
  'request body must include a "terms" array',
  'sync bulk import accepts at most 500 rows; use /bulk/jobs for larger payloads',
  'async bulk import accepts at most 10000 rows',
];

const CJK = /[　-〿㐀-䶿一-鿿＀-￯]/;

describe('parseVocabularyValidationMessage（#609/#634）', () => {
  it('识别引擎“非法规范名”诊断并提取名称', () => {
    expect(parseVocabularyValidationMessage(engineMessage('1 bad name!'))).toEqual({
      reason: 'invalidCanonical',
      values: { name: '1 bad name!' },
    });
  });

  it('引擎每一种诊断形态都能识别', () => {
    const reasons = Object.fromEntries(
      Object.entries(ENGINE_MESSAGES).map(([key, message]) => [key, parseVocabularyValidationMessage(message)?.reason]),
    );
    expect(reasons).toEqual({
      invalidCanonical: 'invalidCanonical',
      duplicateCanonical: 'duplicateCanonical',
      duplicateLocalized: 'duplicateLocalized',
      triggerConflict: 'triggerConflict',
      emptyLiteral: 'invalidLiteral',
      controlLiteral: 'invalidLiteral',
      quotedLiteral: 'invalidLiteral',
      fieldWithoutParent: 'parentRequired',
      registryWrapper: 'invalidCanonical',
    });
  });

  it('识别服务层英文前置校验（含批量行前缀）', () => {
    for (const message of SERVER_MESSAGES) {
      expect(parseVocabularyValidationMessage(message), message).not.toBeNull();
    }
    expect(parseVocabularyValidationMessage('parentCanonical is required for kind=field')).toEqual({
      reason: 'parentRequired',
      values: {},
    });
    expect(parseVocabularyValidationMessage('canonical is required')).toEqual({
      reason: 'fieldRequired',
      values: { field: 'canonical' },
    });
    expect(parseVocabularyValidationMessage('domain and locale are required')).toEqual({
      reason: 'fieldRequired',
      values: { field: 'domain' },
    });
    expect(parseVocabularyValidationMessage('terms[3].canonical must be a string')).toEqual({
      reason: 'invalidValue',
      values: { field: 'canonical' },
    });
    expect(parseVocabularyValidationMessage('sync bulk import accepts at most 500 rows; use /bulk/jobs')).toEqual({
      reason: 'bulkTooMany',
      values: { limit: '500' },
    });
  });

  it('识别重复规范名与触发词冲突', () => {
    expect(parseVocabularyValidationMessage('structs[1]: 规范化名称 "Driver" 重复')?.reason).toBe('duplicateCanonical');
    expect(
      parseVocabularyValidationMessage('literals[0]: 触发词 "vip" 与另一条映射冲突（…）'),
    ).toEqual({ reason: 'triggerConflict', values: { trigger: 'vip' } });
  });

  it('识别不了或为空 → null（界面显示通用本地化提示）', () => {
    expect(parseVocabularyValidationMessage('something unexpected')).toBeNull();
    expect(parseVocabularyValidationMessage('某个未知的中文诊断')).toBeNull();
    expect(parseVocabularyValidationMessage(undefined)).toBeNull();
  });
});

/** 与运行时 request.ts 同口径合并文案：en 底座 → 当前语言包 → en 补充 → 当前语言补充。 */
const ROOT = path.resolve(__dirname, '../../..');
const PKG = {
  en: 'node_modules/@aster-cloud/ui-messages/en-US.json',
  de: 'node_modules/@aster-cloud/ui-messages/de-DE.json',
  hi: 'node_modules/@aster-cloud/ui-messages-hi/hi-IN.json',
} as const;

function translatorFor(locale: keyof typeof PKG): VocabularyValidationTranslate {
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  let messages = deepMergeMessages(read(PKG.en), read(PKG[locale]));
  messages = deepMergeMessages(messages, DEMO_SUPPLEMENT.en);
  messages = deepMergeMessages(messages, DEMO_SUPPLEMENT[locale]);
  const t = createTranslator({ locale, messages, namespace: 'domainVocabularies' }) as unknown as (
    key: string,
    values?: Record<string, string>,
  ) => string;
  return (key, values) => t(key, values);
}

describe('词汇校验失败在 en/de/hi 下不显示中文（#634）', () => {
  const all = [...Object.values(ENGINE_MESSAGES), ...SERVER_MESSAGES, 'something unexpected', '某个未知的中文诊断'];
  for (const locale of Object.keys(PKG) as Array<keyof typeof PKG>) {
    it(`[${locale}] 每一种已知校验失败都渲染为本地化文案`, () => {
      const t = translatorFor(locale);
      for (const message of all) {
        const text = vocabularyValidationText(message, t);
        expect(text, message).not.toMatch(CJK);
        // 渲染结果是文案而不是 key 路径（缺键时 next-intl 返回 key）
        expect(text, message).not.toMatch(/^domainVocabularies\.|errors\.validation\./);
      }
      expect(vocabularyValidationText(ENGINE_MESSAGES.invalidCanonical, t)).toContain('Bad Name!');
    });
  }

  it('每个原因码在 en/zh/de/hi 补充文案里都有', () => {
    const reasons = new Set(
      [...Object.values(ENGINE_MESSAGES), ...SERVER_MESSAGES].map((m) => parseVocabularyValidationMessage(m)!.reason),
    );
    for (const locale of ['en', 'zh', 'de', 'hi'] as const) {
      const validation = (DEMO_SUPPLEMENT[locale] as { domainVocabularies: { errors: { validation: Record<string, string> } } })
        .domainVocabularies.errors.validation;
      for (const reason of [...reasons, 'generic']) expect(validation[reason], `${locale}.${reason}`).toBeTruthy();
    }
  });
});
