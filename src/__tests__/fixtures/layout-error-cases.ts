/**
 * layout 错误码矩阵（ADR 0058 §7.5，计划「layout 错误码矩阵」）：存储服务、createVersion、保存路由与编辑器的
 * 参数化测试共用同一张表。每个反例与合法对照 LAYOUT_VALID_CASE 只差一处。
 */
import type { LayoutLimitName, LayoutSpan, PolicyLayout } from '@aster-cloud/aster-lang-ts/layout';
import type { LayoutSaveErrorCode } from '@/lib/policy-layout/errors';

export interface LayoutErrorCase {
  name: string;
  code: LayoutSaveErrorCode;
  status: 400 | 403;
  input: { layout: unknown; source: string; locale: string; aliasSet?: Record<string, string[]> };
  expect: { offset?: number; limit?: LayoutLimitName };
}

const layout = (spans: LayoutSpan[]): PolicyLayout => ({ v: 1, spans });

/** 合法对照的源码与 layout：模块声明后的空行在 display 里收成一个换行。 */
export const LAYOUT_SOURCE =
  'Module demo.layout.\n\nRule decide given amount as Int, produce Int:\n  Return amount.\n';
const HEAD = 'Module demo.layout';
const BODY = 'Rule decide given amount as Int, produce Int:\n  Return amount.\n';
const VALID_LAYOUT = layout([{ text: HEAD }, { canonical: '.\n\n', display: '\n' }, { text: BODY }]);

export const LAYOUT_VALID_CASE: LayoutErrorCase['input'] = {
  layout: VALID_LAYOUT,
  source: LAYOUT_SOURCE,
  locale: 'en-US',
};

/** 带注释行的源码：注释里有引号，放进结构 span 不藏值但违反 content parity。 */
const QUOTED_COMMENT_SOURCE = `${HEAD}.\n# "note"\n${BODY}`;

/** 12289 字节源码：超 sourceBytes。 */
const OVERSIZED_SOURCE = `${HEAD}.\n${'#'.repeat(12288 - HEAD.length - 2)}\n`;

/** 802 个 span（内容与结构交替）：超 spans。 */
const MANY_SPANS: LayoutSpan[] = Array.from({ length: 401 }, (_, i) => [
  { text: `a${i}` } as LayoutSpan,
  { canonical: ' ', display: '' } as LayoutSpan,
]).flat();
const MANY_SPANS_SOURCE = MANY_SPANS.map((s) => ('text' in s ? s.text : s.canonical)).join('');

export const LAYOUT_ERROR_CASES: ReadonlyArray<LayoutErrorCase> = [
  {
    name: 'format version 2',
    code: 'layout_invalid_format',
    status: 400,
    input: { ...LAYOUT_VALID_CASE, layout: { ...VALID_LAYOUT, v: 2 } },
    expect: {},
  },
  {
    name: 'source over sourceBytes',
    code: 'layout_too_large',
    status: 400,
    input: { layout: layout([{ text: OVERSIZED_SOURCE }]), source: OVERSIZED_SOURCE, locale: 'en-US' },
    expect: { limit: 'sourceBytes' },
  },
  {
    name: 'more spans than the limit',
    code: 'layout_too_large',
    status: 400,
    input: { layout: layout(MANY_SPANS), source: MANY_SPANS_SOURCE, locale: 'en-US' },
    expect: { limit: 'spans' },
  },
  {
    name: 'canonical differs from source',
    code: 'layout_roundtrip_mismatch',
    status: 400,
    input: {
      ...LAYOUT_VALID_CASE,
      layout: layout([{ text: HEAD }, { canonical: '.\n\n', display: '\n' }, { text: BODY.replace('amount.\n', 'amount!\n') }]),
    },
    expect: { offset: 82 },
  },
  {
    name: 'structural span hides an identifier',
    code: 'layout_structural_hides_value',
    status: 400,
    input: {
      ...LAYOUT_VALID_CASE,
      layout: layout([
        { text: `${HEAD}.\n\nRule decide given ` },
        { canonical: 'amount', display: 'x' },
        { text: ' as Int, produce Int:\n  Return amount.\n' },
      ]),
    },
    expect: { offset: 39 },
  },
  {
    name: 'structural span carries a quote',
    code: 'layout_content_parity',
    status: 400,
    input: {
      layout: layout([{ text: `${HEAD}.\n` }, { canonical: '# "note"\n', display: '' }, { text: BODY }]),
      source: QUOTED_COMMENT_SOURCE,
      locale: 'en-US',
    },
    expect: {},
  },
  {
    // 门禁由调用方制造（allowLayout:false 或能力解析为拒绝）；input 本身合法。
    name: 'caller lacks structured_authoring',
    code: 'structured_authoring_required',
    status: 403,
    input: LAYOUT_VALID_CASE,
    expect: {},
  },
];
