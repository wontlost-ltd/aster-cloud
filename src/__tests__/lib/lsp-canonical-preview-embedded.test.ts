// @vitest-environment node
/**
 * 策略内嵌词汇进入 LSP 与规范预览（ADR 0060 §7.5，计划 T11）。
 *
 * 编辑器把「内嵌 > 团队 > 作者」合并后的有效词汇作为 domainVocabularies 经 initializationOptions 下发
 * （useUserVocabularyRegistration → MonacoPolicyEditor → useAsterLSP）。本用例用与编辑器相同的合并
 * （mergeEmbeddedVocabulary）构造这份词汇，对真实网关 + 语言服务器请求 zh-CN《静夜思》的规范预览：
 * 字面量触发词 `思故乡` 换成 zh-CN 的字符串字面量 `「静夜思」`（引号随 lexicon），结构体写法 `望明月` 换成 `Text`。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { mergeEmbeddedVocabulary, toDomainVocabulary, type EmbeddedVocabulary } from '@/lib/policy-embedded-vocabulary';
import { closeLspPreviewHarness, requestLspPreview } from '../fixtures/lsp-preview-harness';

const DOC = '模块 明月光。\n规则 地上霜，产出 望明月：\n  返回 思故乡。';
const POEM: EmbeddedVocabulary = {
  v: 1,
  terms: [
    { kind: 'literal', localized: '思故乡', canonical: '静夜思' },
    { kind: 'struct', localized: '望明月', canonical: 'Text' },
  ],
};

afterAll(closeLspPreviewHarness);

function editorVocabulary() {
  const { vocabulary } = mergeEmbeddedVocabulary(toDomainVocabulary(POEM, 'zh-CN'), null);
  return vocabulary!;
}

describe('zh-CN 内嵌词汇的规范预览（真实网关 + 语言服务器）', () => {
  it('★字面量宏展开为字符串，结构体写法换成规范名', async () => {
    const p = await requestLspPreview({
      locale: 'zh-CN',
      tenantId: 'tenant-embedded',
      domain: 'default',
      doc: DOC,
      vocabularies: [editorVocabulary()],
    });
    expect(p).not.toBeNull();
    expect(p!.text).toBe(DOC.replace('望明月', 'Text').replace('思故乡', '「静夜思」'));
    const literal = p!.mappings.find((m) => DOC.slice(...m.source) === '思故乡');
    expect(literal).toBeDefined();
    expect(p!.text.slice(...literal!.preview)).toBe('「静夜思」');
  }, 30_000);

  it('不带内嵌词汇：预览原样', async () => {
    const p = await requestLspPreview({ locale: 'zh-CN', tenantId: 'tenant-embedded-none', domain: 'default', doc: DOC, vocabularies: undefined });
    expect(p).not.toBeNull();
    expect(p!.text).toBe(DOC);
    expect(p!.mappings).toEqual([]);
  }, 30_000);
});
