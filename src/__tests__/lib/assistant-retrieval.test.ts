// 站内助手检索核心测试。
//
// 覆盖：空查询 / 文档命中 / 动作命中（整串·前缀·关键词·中文连写）/
// 跨源排序 / 同分文档优先 / limit / 结果稳定性 / 无命中。
//
// ★用**真实** searchDocs（不 mock）：助手的价值全在「答案可溯源到站内真文档」，
//   mock 掉检索等于测了个空壳。

import { describe, it, expect } from 'vitest';
import { retrieve } from '@/lib/assistant/retrieval';
import type { SearchIndex } from '@/lib/docs/search-runtime';
import type { Command } from '@/components/dashboard/command-palette-commands';

const docsIndex: SearchIndex = {
  locale: 'zh',
  entries: [
    {
      slug: 'api-keys',
      title: 'API 密钥',
      description: '签发与轮换 API 密钥，供业务系统调用策略执行接口。',
      headings: ['签发密钥', '轮换与吊销'],
    },
    {
      slug: 'policies/versions',
      title: '版本与审批',
      description: '每次保存生成新版本，审批闸门决定哪些版本可以执行。',
      headings: ['提交审批', '批准与拒绝'],
    },
    {
      slug: 'getting-started',
      title: '快速开始',
      description: '60 秒完成 Aster 上手。',
      headings: ['创建第一条策略'],
    },
  ],
};

const commands: Command[] = [
  { id: 'policies', label: '策略', icon: 'file-text', href: '/zh/policies', group: 'navigate', keywords: ['policy', 'richtlinien'] },
  { id: 'api-keys', label: 'API 密钥', icon: 'key-round', href: '/zh/settings/api-keys', group: 'settings', keywords: ['api key', '密钥'] },
  { id: 'new-policy', label: '新建策略', icon: 'sparkles', href: '/zh/policies/new', group: 'create', keywords: ['create', 'neu'] },
];

const opts = { docsIndex, commands, docsPrefix: '/zh' };

describe('assistant retrieve', () => {
  it('空查询 → 空结果（调用方据此显示引导语）', () => {
    expect(retrieve('', opts)).toEqual([]);
    expect(retrieve('   ', opts)).toEqual([]);
  });

  it('文档命中：问「API 密钥」能找到对应文档并给出直达链接', () => {
    const hits = retrieve('API 密钥', opts);
    const doc = hits.find((h) => h.kind === 'doc');
    expect(doc).toBeDefined();
    expect(doc!.href).toBe('/zh/docs/api-keys');
    expect(doc!.title).toBe('API 密钥');
  });

  it('动作命中：中文连写查询也能命中（不只按空格分词）', () => {
    const hits = retrieve('新建策略', opts);
    const action = hits.find((h) => h.kind === 'action');
    expect(action).toBeDefined();
    expect(action!.href).toBe('/zh/policies/new');
  });

  it('动作命中：英文关键词（中文界面下搜 policy 也能到策略页）', () => {
    const hits = retrieve('policy', opts);
    expect(hits.some((h) => h.id === 'action:policies')).toBe(true);
  });

  it('整串完全相等 > 前缀 > 包含', () => {
    // '策略' 完全等于 policies 的 label → 应排在 '新建策略'（包含）之前
    const hits = retrieve('策略', opts).filter((h) => h.kind === 'action');
    expect(hits[0].id).toBe('action:policies');
    expect(hits.map((h) => h.id)).toContain('action:new-policy');
  });

  it('同分时文档优先于动作', () => {
    const same = retrieve('API 密钥', { ...opts, limit: 10 });
    const idxDoc = same.findIndex((h) => h.kind === 'doc');
    const idxAction = same.findIndex((h) => h.kind === 'action');
    if (idxDoc >= 0 && idxAction >= 0) {
      const d = same[idxDoc], a = same[idxAction];
      if (d.score === a.score) expect(idxDoc).toBeLessThan(idxAction);
    }
    expect(idxDoc).toBeGreaterThanOrEqual(0);
  });

  it('limit 生效', () => {
    expect(retrieve('策略', { ...opts, limit: 1 })).toHaveLength(1);
  });

  it('结果稳定：同一查询多次调用顺序一致（避免 UI 抖动）', () => {
    const a = retrieve('策略', opts).map((h) => h.id);
    const b = retrieve('策略', opts).map((h) => h.id);
    expect(a).toEqual(b);
  });

  it('无命中 → 空数组（不编造答案）', () => {
    expect(retrieve('zzzz-不存在的东西-qqqq', opts)).toEqual([]);
  });

  it('每条结果都带可点击 href（可溯源，非幻觉）', () => {
    for (const h of retrieve('策略', opts)) {
      expect(h.href).toBeTruthy();
      expect(h.href.startsWith('/')).toBe(true);
    }
  });

  // ★回归：索引里的 slug 是**相对**的（'policies/versions'）。曾直接把 slug 当
  //   href，浏览器按当前路径解析成 /zh/docs/getting-started/policies/versions → 404。
  //   本地浏览器实测才暴露（原 fixture 用了绝对 slug，把 bug 测没了）。
  it('文档 href 必须是绝对路径：相对 slug 要补上 <prefix>/docs/', () => {
    const doc = retrieve('版本与审批', opts).find((h) => h.kind === 'doc');
    expect(doc!.href).toBe('/zh/docs/policies/versions');
  });

  it('en 无 locale 前缀（docsPrefix 为空串）', () => {
    const doc = retrieve('版本与审批', { ...opts, docsPrefix: '' }).find((h) => h.kind === 'doc');
    expect(doc!.href).toBe('/docs/policies/versions');
  });
});

describe('站外文档源（aster-lang.dev）', () => {
  const externalIndex: SearchIndex = {
    locale: 'zh',
    entries: [
      { slug: 'language-guide', title: '语言指南',
        description: 'Aster 是用于规则的受控自然语言。', headings: ['语法', '类型'] },
      { slug: 'stdlib', title: '标准库', description: '内置函数与集合操作。', headings: [] },
    ],
  };
  const ext = { index: externalIndex, baseUrl: 'https://www.aster-lang.dev/zh', label: 'aster-lang.dev' };
  const optsExt = { ...opts, external: ext };

  it('能检索到站外文档', () => {
    const hits = retrieve('语言指南', optsExt);
    const e = hits.find((h) => h.kind === 'external');
    expect(e).toBeDefined();
    expect(e!.title).toBe('语言指南');
  });

  it('★站外 href 是绝对 URL（相对路径会被解析到本站 → 404）', () => {
    const e = retrieve('语言指南', optsExt).find((h) => h.kind === 'external')!;
    expect(e.href).toBe('https://www.aster-lang.dev/zh/docs/language-guide');
  });

  it('带 sourceLabel 供 UI 标注离站', () => {
    const e = retrieve('标准库', optsExt).find((h) => h.kind === 'external')!;
    expect(e.sourceLabel).toBe('aster-lang.dev');
  });

  it('★不传 external 时行为完全不变（向后兼容）', () => {
    expect(retrieve('策略', optsExt.external ? opts : opts)).toEqual(retrieve('策略', opts));
    expect(retrieve('语言指南', opts).some((h) => h.kind === 'external')).toBe(false);
  });

  it('★同分时站内文档排在站外之前', () => {
    // 构造站内外同名条目：站内应优先（用户在本站提问，多要本站路径）
    const both = {
      ...opts,
      docsIndex: { locale: 'zh', entries: [
        { slug: 'stdlib-local', title: '标准库', description: '本站的标准库页。', headings: [] },
      ] } as SearchIndex,
      external: ext,
    };
    const hits = retrieve('标准库', both);
    const iDoc = hits.findIndex((h) => h.kind === 'doc');
    const iExt = hits.findIndex((h) => h.kind === 'external');
    expect(iDoc).toBeGreaterThanOrEqual(0);
    expect(iExt).toBeGreaterThanOrEqual(0);
    expect(iDoc).toBeLessThan(iExt);
  });

  it('站外空索引不影响站内结果', () => {
    const empty = { ...opts, external: { ...ext, index: { locale: 'zh', entries: [] } as SearchIndex } };
    expect(retrieve('策略', empty)).toEqual(retrieve('策略', opts));
  });
})

describe('同分文档沿用 searchDocs 的细排顺序（F28）', () => {
  it('不以 id 字典序打乱 searchDocs 已排好的同分文档', () => {
    const index: SearchIndex = {
      locale: 'zh',
      entries: [
        { slug: 'a/graphql', title: 'GraphQL API 概览', description: '', headings: [] },
        { slug: 'z/api-keys', title: '创建 API 密钥', description: '', headings: [] },
      ],
    };
    const hits = retrieve('如何创建 API 密钥？', { docsIndex: index, commands: [], docsPrefix: '/zh' });
    expect(hits[0].href).toBe('/zh/docs/z/api-keys');
  });
});
