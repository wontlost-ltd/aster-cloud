import { describe, it, expect } from 'vitest';
import { validateDomainVocabulary } from '@/lib/domain-vocabulary-validation';
import { assembleDomainVocabularyFromLinks } from '@/lib/domain-vocabulary-assemble';
import { parseVocabularyValidationMessage } from '@/lib/vocabulary-validation-message';

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

describe('parseVocabularyValidationMessage（#609）', () => {
  it('识别引擎“非法规范名”诊断并提取名称', () => {
    expect(parseVocabularyValidationMessage(engineMessage('1 bad name!'))).toEqual({
      reason: 'invalidCanonical',
      values: { name: '1 bad name!' },
    });
  });

  it('识别服务层英文前置校验', () => {
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
  });

  it('识别重复规范名与触发词冲突', () => {
    expect(parseVocabularyValidationMessage('structs[1]: 规范化名称 "Driver" 重复')?.reason).toBe('duplicateCanonical');
    expect(
      parseVocabularyValidationMessage('literals[0]: 触发词 "vip" 与另一条映射冲突（…）'),
    ).toEqual({ reason: 'triggerConflict', values: { trigger: 'vip' } });
  });

  it('识别不了或为空 → null（界面显示通用本地化提示）', () => {
    expect(parseVocabularyValidationMessage('something unexpected')).toBeNull();
    expect(parseVocabularyValidationMessage(undefined)).toBeNull();
  });
});
