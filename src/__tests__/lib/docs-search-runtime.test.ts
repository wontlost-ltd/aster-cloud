/**
 * Behavioural coverage for the docs search runtime: ranking tiers,
 * synonym expansion, current-route boost, result limit.
 */

import { describe, it, expect } from 'vitest';
import {
  expandQuery,
  searchDocs,
  type SearchIndex,
} from '@/lib/docs/search-runtime';

const sampleIndex: SearchIndex = {
  locale: 'en',
  entries: [
    {
      slug: 'getting-started/quickstart',
      title: 'Quick Start',
      description: 'Walks you through your first policy evaluation.',
      headings: ['Prerequisites', 'Set Your Credentials', 'Evaluate a Policy'],
    },
    {
      slug: 'api/policies/evaluate',
      title: 'Evaluate Policy',
      description: 'Evaluate a deployed policy by module and function name.',
      headings: ['Required Role', 'Request Body', 'Response'],
    },
    {
      slug: 'api/audit/logs',
      title: 'Audit Logs',
      description: 'Query the immutable audit log for compliance review.',
      headings: ['Filters', 'Pagination', 'Examples'],
    },
    {
      slug: 'getting-started/authentication',
      title: 'Authentication',
      description: 'Configure HMAC signing for production requests.',
      headings: ['HMAC Headers', 'Replay Window', 'Failure Modes'],
    },
  ],
};

describe('expandQuery', () => {
  it('returns lowercase tokens, deduped', () => {
    expect(expandQuery('Evaluate Evaluate')).toEqual(['evaluate']);
  });

  it('respects the synonym map', () => {
    const tokens = expandQuery('auth', { auth: 'authentication' });
    expect(tokens).toContain('auth');
    expect(tokens).toContain('authentication');
  });

  it('drops punctuation around tokens', () => {
    expect(expandQuery('"audit",')).toContain('audit');
  });
});

describe('searchDocs ranking', () => {
  it('ranks exact title above prefix match', () => {
    const hits = searchDocs('audit logs', sampleIndex);
    expect(hits[0].entry.slug).toBe('api/audit/logs');
  });

  it('ranks title match above heading match', () => {
    const hits = searchDocs('evaluate', sampleIndex);
    // "Evaluate Policy" (title) ranks above "Evaluate a Policy" (heading)
    expect(hits[0].entry.slug).toBe('api/policies/evaluate');
  });

  it('returns empty array for whitespace-only query', () => {
    expect(searchDocs('   ', sampleIndex)).toEqual([]);
  });

  it('returns empty array for unmatched query', () => {
    expect(searchDocs('nonexistent gibberish', sampleIndex)).toEqual([]);
  });

  it('respects the limit option', () => {
    const hits = searchDocs('policy', sampleIndex, { limit: 1 });
    expect(hits.length).toBe(1);
  });

  it('current-route boost bubbles same-tier matches', () => {
    // "policy" matches the title-prefix of Evaluate Policy (TIER 700)
    // and Quick Start (title-prefix? no — "Quick Start" doesn't
    // contain "policy"). So I use a tighter probe: searching for
    // "audit" matches Audit Logs's title (700) and there are no
    // other title-tier matches. Within the same tier, alphabetical
    // slug order is the tiebreaker. Add a synthetic second
    // title-match to demonstrate the boost.
    const indexWithTie: SearchIndex = {
      locale: 'en',
      entries: [
        {
          slug: 'a-page',
          title: 'Audit',
          description: '',
          headings: [],
        },
        {
          slug: 'z-page',
          title: 'Audit',
          description: '',
          headings: [],
        },
      ],
    };
    const baseline = searchDocs('audit', indexWithTie);
    expect(baseline[0].entry.slug).toBe('a-page'); // alphabetical tiebreak
    const boosted = searchDocs('audit', indexWithTie, {
      boostSlug: 'z-page',
    });
    expect(boosted[0].entry.slug).toBe('z-page'); // boost wins same tier
  });

  it('current-route boost does NOT override tier ordering', () => {
    // True cross-tier guarantee: even when the user is on a page
    // with only a description match, a title-match elsewhere still
    // wins. The +50 boost is intentionally smaller than the gap
    // between any two tiers (description 250 < heading 500).
    const indexCrossTier: SearchIndex = {
      locale: 'en',
      entries: [
        {
          slug: 'page-with-title-match',
          title: 'audit',
          description: '',
          headings: [],
        },
        {
          slug: 'page-with-description-only',
          title: 'Unrelated',
          description: 'discussion of audit topics',
          headings: [],
        },
      ],
    };
    const hits = searchDocs('audit', indexCrossTier, {
      boostSlug: 'page-with-description-only',
    });
    // Title match wins (1000) over boosted description (250 + 50).
    expect(hits[0].entry.slug).toBe('page-with-title-match');
  });

  it('synonym map widens recall without changing tier', () => {
    const hits = searchDocs('auth', sampleIndex, {
      synonyms: { auth: 'authentication' },
    });
    expect(hits[0].entry.slug).toBe('getting-started/authentication');
  });

  it('matched field is reported in the result', () => {
    const hits = searchDocs('compliance', sampleIndex);
    expect(hits[0].matchedIn).toBe('description');
  });
});

describe('CJK 连写查询（中文自然提问）', () => {
  const zhIndex: SearchIndex = {
    locale: 'zh',
    entries: [
      { slug: 'getting-started/quickstart', title: '快速开始',
        description: '五分钟内运行第一次策略评估。', headings: ['创建第一条策略'] },
      { slug: 'api/policies/versions', title: '获取策略版本历史',
        description: '获取策略的完整版本历史。', headings: [] },
      { slug: 'api/audit/compare', title: '版本比较',
        description: '比较两个版本的差异。', headings: [] },
    ],
  };

  // ★回归：expandQuery 原本只按空白分词，中文句子没有空格 →
  //   整句变成一个超长 token，任何标题都不包含它 → 零命中。
  //   用户自然提问几乎必然落进这个坑（线上实测「如何开始第一个策略的编写」返回空）。
  it('整句中文提问不再零命中', () => {
    const hits = searchDocs('如何开始第一个策略的编写', zhIndex);
    expect(hits.length).toBeGreaterThan(0);
  });

  it('整句提问能命中其中的词组', () => {
    const titles = searchDocs('如何开始第一个策略的编写', zhIndex).map((h) => h.entry.title);
    expect(titles).toContain('快速开始');
  });

  // ★n-gram 会产生大量 2 字碎片；若不按命中长度排序，
  //   精确匹配会被碎片命中挤到后面（实测「版本历史」曾把精确项排到最后）。
  it('更完整的匹配排在碎片匹配之前', () => {
    const hits = searchDocs('版本历史', zhIndex);
    expect(hits[0].entry.title).toBe('获取策略版本历史');
  });

  it('英文查询行为不变（仍按空白分词）', () => {
    const hits = searchDocs('quickstart', zhIndex);
    expect(hits.map((h) => h.entry.slug)).toContain('getting-started/quickstart');
  });

  it('单字不生成 n-gram（窗口最小 2 字）', () => {
    // 单字仍按原有的整串子串匹配走（这是改动前就有的行为，未变），
    // 但不应额外炸出 n-gram 切片。这里断言切片逻辑本身的边界。
    expect(expandQuery('的')).toEqual(['的']);
    expect(expandQuery('版本')).toContain('版本');
  });
});

describe('同层级同长度：覆盖更多问句 token 的条目优先（F28）', () => {
  it('「如何创建 API 密钥」下只碰到 "api" 的条目不再靠 slug 字典序排在前面', () => {
    const index = {
      locale: 'zh',
      entries: [
        { slug: 'a/graphql', title: 'GraphQL API 概览', description: '', headings: [] },
        { slug: 'z/api-keys', title: '创建 API 密钥', description: '', headings: [] },
      ],
    };
    const hits = searchDocs('如何创建 API 密钥？', index);
    expect(hits.map((h) => h.entry.slug)).toEqual(['z/api-keys', 'a/graphql']);
  });
});
