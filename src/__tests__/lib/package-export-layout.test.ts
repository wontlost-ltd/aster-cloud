// @vitest-environment node
// 策略包导出读取显示排版（ADR 0059 修订 4 D11 第 1 步、D13）：loadExportLayout 的 included / absent / omitted 三种结论，
// 以及 Worker 复核（runNodeCheck）里用 ts 跑的包排版规则 L1–L9。prepareLayout 与 ts 规则都是真实实现，只 mock 读库与开关。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeLayout, toDisplay } from '@aster-cloud/aster-lang-ts/layout';
import { TS_VERSION, compileSourcePositionFreeSha256 } from '@aster-cloud/aster-lang-ts/package-check';
import { JINGYESI_LAYOUT, JINGYESI_POEM, JINGYESI_SOURCE } from '@/config/jingyesi-poem';
import type { PackageExportPrepareResponse } from '@/services/policy/policy-api';

const h = vi.hoisted(() => ({ loadVersionLayout: vi.fn(), layoutFlag: vi.fn() }));
vi.mock('@/lib/platform-settings', () => ({ isPolicyPackageLayoutExportEnabled: () => h.layoutFlag() }));
vi.mock('@/lib/policy-layout/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/policy-layout/store')>()),
  loadVersionLayout: (...a: unknown[]) => h.loadVersionLayout(...a),
}));

const { loadExportLayout } = await import('@/lib/package-export-layout');
const { keywordSpellings, layoutRuleContext, runNodeCheck } = await import('@/lib/package-node-check');

/** 《静夜思》版本：ADR 0060 §8 的冻结 aliasSet 与合并词汇（含字面量宏 思故乡 → 静夜思）。 */
const ALIAS_SET = { MODULE_DECL: ['床前'], FUNC_TO: ['疑是'], FUNC_PRODUCE: ['举头'], RETURN: ['低头'] };
const VOCABULARY = {
  id: 'policy.embedded', name: 'policy', locale: 'zh-CN', version: '1',
  structs: [{ localized: '望明月', canonical: 'Text', kind: 'struct' }], fields: [], functions: [], enumValues: [],
  literals: [{ localized: '思故乡', canonical: '静夜思', kind: 'literal' }],
};
const version = { id: 'v-poem', source: JINGYESI_SOURCE, locale: 'zh-CN', aliasSet: ALIAS_SET };
const POEM_LAYOUT_TEXT = serializeLayout(JINGYESI_LAYOUT);

beforeEach(() => {
  vi.clearAllMocks();
  h.layoutFlag.mockResolvedValue(true);
  h.loadVersionLayout.mockResolvedValue({ status: 'ok', layout: JINGYESI_LAYOUT, layoutSha256: 'aa'.repeat(32) });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('loadExportLayout', () => {
  it('《静夜思》→ included，文本为存储的规范序列化（与 conformance 黄金包的 layout.json 同一字节）', async () => {
    const r = await loadExportLayout(version);
    expect(r).toEqual({ kind: 'included', layout: POEM_LAYOUT_TEXT });
    expect(h.loadVersionLayout).toHaveBeenCalledWith('v-poem');
    expect(toDisplay(JINGYESI_LAYOUT)).toBe(JINGYESI_POEM);
    expect(createHash('sha256').update(POEM_LAYOUT_TEXT).digest('hex'))
      .toBe('4c22316c10c4298c2d046a7cffa8aaec67f87643f34fa3b8eaebe073ff75a508');
  });

  it('版本无排版 → absent（不论开关）', async () => {
    h.loadVersionLayout.mockResolvedValue({ status: 'none' });
    h.layoutFlag.mockResolvedValue(false);
    expect(await loadExportLayout(version)).toEqual({ kind: 'absent' });
  });

  it('开关关 → layout_export_disabled', async () => {
    h.layoutFlag.mockResolvedValue(false);
    expect(await loadExportLayout(version)).toEqual({ kind: 'omitted', reason: 'layout_export_disabled' });
  });

  it('读取复验不过（inconsistent）或读取出错 → layout_inconsistent', async () => {
    h.loadVersionLayout.mockResolvedValue({ status: 'inconsistent', layoutSha256: 'aa'.repeat(32) });
    expect(await loadExportLayout(version)).toEqual({ kind: 'omitted', reason: 'layout_inconsistent' });
    h.loadVersionLayout.mockRejectedValue(new Error('db down'));
    expect(await loadExportLayout(version)).toEqual({ kind: 'omitted', reason: 'layout_inconsistent' });
  });

  it('保存校验（prepareLayout）不过 → layout_invalid：往返仍成立，但结构 span 藏起了字面量触发词', async () => {
    const hiding = {
      v: 1 as const,
      spans: JINGYESI_LAYOUT.spans.map((sp) => ('text' in sp && sp.text === '思故乡' ? { canonical: '思故乡', display: '' } : sp)),
    };
    h.loadVersionLayout.mockResolvedValue({ status: 'ok', layout: hiding, layoutSha256: 'aa'.repeat(32) });
    expect(await loadExportLayout(version)).toEqual({ kind: 'omitted', reason: 'layout_invalid' });
  });

  it("includes the layout regardless of the exporter's capability", async () => {
    // loadExportLayout 不接收导出者身份：排版随版本导出，与 structured_authoring 能力无关（修订 4 D11 第 4 条）
    expect(loadExportLayout.length).toBe(1);
    expect(await loadExportLayout(version)).toMatchObject({ kind: 'included' });
  });
});

/** 共享向量 keyword-spellings.json（aster-lang-test / ts / core 的逐字节副本）。 */
const SPELLINGS_PATH = join(__dirname, '../../lib/__fixtures__/layout_keyword_spellings.json');
const SPELLINGS = JSON.parse(readFileSync(SPELLINGS_PATH, 'utf8')) as {
  operatorKinds: string[];
  locales: Record<string, { literal: string[]; operator: string[] }>;
};

describe('layoutRuleContext（L6(c) / L7 的拼写）', () => {
  it('向量副本与 ts v3.7.0 shared/layout-vectors、aster-lang-test 的 sha256 相同', () => {
    expect(createHash('sha256').update(readFileSync(SPELLINGS_PATH)).digest('hex'))
      .toBe('467b1075dd67e2e7249d50ae3b47eb5c1f00a2f1827dcf501016e97ef906fd3f');
  });

  it.each(['en-US', 'zh-CN', 'de-DE', 'hi-IN'])('%s：cloud 词法表的拼写与向量相同（计划裁决 PR4）', (locale) => {
    expect(keywordSpellings(locale)).toEqual(SPELLINGS.locales[locale]);
  });

  it('运算符 kind 清单与向量相同；aliasSet 只并入运算符 kind 的别名', async () => {
    const { OPERATOR_KINDS } = await import('@/lib/policy-alias-shared');
    expect([...OPERATOR_KINDS].sort()).toEqual([...SPELLINGS.operatorKinds].sort());
    const ctx = layoutRuleContext({ source: '', locale: 'zh-CN', aliasSet: { PLUS: ['接 着'], RETURN: ['低头'] }, vocabulary: VOCABULARY });
    expect(ctx.operatorSpellings).toContain('接 着');
    expect(ctx.operatorSpellings).not.toContain('低头');
    expect(ctx.vocabularyLocalized).toEqual(['望明月', '思故乡']);
    expect(ctx.literalKeywords).toEqual([...SPELLINGS.locales['zh-CN']!.literal, ...SPELLINGS.locales['en-US']!.literal]);
  });
});

describe('runNodeCheck：包排版 L1–L9（修订 4 D11 第 1 步）', () => {
  const input = { source: JINGYESI_SOURCE, locale: 'zh-CN', aliasSet: ALIAS_SET, allowStructural: true, vocabulary: VOCABULARY };
  const opts = { locale: 'zh-CN', aliasSetJson: JSON.stringify(ALIAS_SET), allowStructural: true, vocabularyJson: JSON.stringify(VOCABULARY) };
  const pfh = compileSourcePositionFreeSha256(JINGYESI_SOURCE, opts);
  // 平台 Core IR：aster-lang-test conformance `src/display/b-jingyesi/platform-core.json`（aster-cli compile 的输出）的副本
  const coreIr = readFileSync(join(__dirname, '../fixtures/jingyesi-platform-core.json'), 'utf8');
  const prepared: PackageExportPrepareResponse = {
    exportable: true, diagnostics: [], entry: '地上霜', coreIr, coreIrSha256: 'aa'.repeat(32), positionFreeSha256: pfh,
    probes: null, probesJson: '{"probes":[{"entry":"地上霜","expected":{"ok":true,"value":"静夜思"},"input":{}}]}',
    probesSha256: 'bb'.repeat(32), probeCount: 1,
    runtime: { cliName: '@aster-cloud/aster-lang-ts', cliVersion: TS_VERSION, ecosystem: '1.0.55' },
  };

  it('《静夜思》的投影哈希是两引擎的共同值；平台 IR 带出入口名（L8 的名字来源）', async () => {
    expect(pfh).toBe('55512170231ae56d7f01b8130ce368d650c5b390ad6f0ac7f34d5350c8960ec6');
    const { irNameStrings } = await import('@aster-cloud/aster-lang-ts/layout');
    expect(irNameStrings(coreIr)).toEqual(expect.arrayContaining(['明月光', '地上霜']));
  });

  it('L8：入口名整个落在结构 span 里 → layoutOk:false', () => {
    const l8 = POEM_LAYOUT_TEXT.replace('{"text":"地上霜"}', '{"canonical":"地上霜","display":"地上霜"}');
    expect(runNodeCheck(prepared, input, l8)).toMatchObject({ ok: true, layoutOk: false });
  });

  it('不带排版时 layoutOk 恒为 true；诗的排版通过 L1–L9', () => {
    const plain = runNodeCheck(prepared, input);
    expect(plain).toMatchObject({ ok: true, layoutOk: true });
    expect(runNodeCheck(prepared, input, POEM_LAYOUT_TEXT)).toMatchObject({ ok: true, layoutOk: true });
  });

  it.each([
    ['L1 非规范字节', POEM_LAYOUT_TEXT.replace('{"v":1,', '{ "v":1,')],
    ['L3 往返不符', POEM_LAYOUT_TEXT.replace('"明月光"', '"明月光光"')],
    ['L6 结构 span 藏了字面量触发词', POEM_LAYOUT_TEXT.replace('{"text":"思故乡"}', '{"canonical":"思故乡","display":"思故乡"}')],
    ['L7 display 多出运算符', POEM_LAYOUT_TEXT.replace('{"canonical":"，","display":"。\\n"}', '{"canonical":"，","display":"。+\\n"}')],
    ['L9 名字被切进结构 span', POEM_LAYOUT_TEXT.replace('{"text":"明月光"}', '{"text":"明月"},{"canonical":"光","display":"光"}')],
  ])('%s → layoutOk:false，探针结论不受影响', (_name, layout) => {
    expect(layout).not.toBe(POEM_LAYOUT_TEXT);
    expect(runNodeCheck(prepared, input, layout)).toMatchObject({ ok: true, layoutOk: false });
  });
});
