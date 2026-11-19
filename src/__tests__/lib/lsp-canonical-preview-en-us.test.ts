// @vitest-environment node
/**
 * en-US 策略的词汇规范预览（ADR 0058 §8.2；aster-lang-ts#365 在 3.4.0 修复）。
 *
 * ★走生产链路（夹具 lsp-preview-harness：真实网关 + cloud 依赖的那份语言服务器，按编辑器的方式握手），
 *   以 `?locale=en-US` 连接。3.3.0 对 en-US 文档不查租户词汇，预览 `mappings` 为空——C5 的浏览器 e2e 因此改在
 *   de-DE 上验收；本用例锁 en-US。
 */
import { afterAll, describe, expect, it } from 'vitest';
import { closeLspPreviewHarness, requestLspPreview } from '../fixtures/lsp-preview-harness';

const DOMAIN = 'insurance.auto';
const VOCAB = {
  id: DOMAIN, name: 'Auto insurance', locale: 'en-US', version: '1.0.0',
  structs: [{ canonical: 'Driver', localized: 'Motorist', kind: 'struct' }],
  fields: [{ canonical: 'age', localized: 'years', kind: 'field', parent: 'Driver' }],
  functions: [], enumValues: [], literals: [],
};
const DOC = [
  'Module m.',
  '',
  'Define Motorist has years as Int.',
  '',
  'Rule check given f as Motorist, produce Bool:',
  '  Return f.years greater than 17.',
  '',
].join('\n');

afterAll(closeLspPreviewHarness);

const preview = (vocabularies: readonly unknown[] | undefined) =>
  requestLspPreview({ locale: 'en-US', tenantId: 'tenant-en-us', domain: DOMAIN, doc: DOC, vocabularies });

describe('en-US 策略的词汇规范预览（真实网关 + 语言服务器）', () => {
  it('★带领域词汇：Motorist → Driver、years → age，每个 mapping 的 preview 区间即规范名', async () => {
    const p = await preview([VOCAB]);
    expect(p).not.toBeNull();
    expect(p!.text).toBe(DOC.replace(/Motorist/g, 'Driver').replace(/years/g, 'age'));
    expect(p!.mappings.map((m) => m.canonical)).toEqual(['Driver', 'age', 'Driver', 'age']);
    const at = DOC.indexOf('Motorist');
    expect(p!.mappings[0]!.source).toEqual([at, at + 'Motorist'.length]);
    for (const m of p!.mappings) expect(p!.text.slice(...m.preview)).toBe(m.canonical);
  }, 30_000);

  it('无词汇：预览原样、mappings 为空', async () => {
    const p = await preview(undefined);
    expect(p).not.toBeNull();
    expect(p!.text).toBe(DOC);
    expect(p!.mappings).toEqual([]);
  }, 30_000);
});
