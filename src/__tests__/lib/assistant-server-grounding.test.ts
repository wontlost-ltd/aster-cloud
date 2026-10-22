// F15 / F28：服务端补检索。用真实的构建期文档索引（与浏览器助手同源），不 mock 检索。
import { describe, it, expect } from 'vitest';
import { docsLocaleOf, retrieveServerGrounding } from '@/lib/assistant/server-grounding';
import { MAX_GROUNDING_HITS } from '@/lib/assistant/retrieval';

describe('docsLocaleOf', () => {
  it('全码与短码都归一为文档索引的短码', () => {
    expect(docsLocaleOf('zh-CN')).toBe('zh');
    expect(docsLocaleOf('de-DE')).toBe('de');
    expect(docsLocaleOf('en_US')).toBe('en');
    expect(docsLocaleOf('zh')).toBe('zh');
    expect(docsLocaleOf(undefined)).toBe('en');
    expect(docsLocaleOf(42)).toBe('en');
  });
});

describe('retrieveServerGrounding', () => {
  it('★「如何创建 API 密钥？」命中新增的创建 API 密钥文档，摘要含操作步骤', () => {
    const hits = retrieveServerGrounding('如何创建 API 密钥？', 'zh-CN');
    expect(hits[0].href).toBe('/zh/docs/getting-started/api-keys');
    expect(hits[0].title).toBe('创建 API 密钥');
    expect(hits[0].snippet).toContain('Authorization: Bearer');
  });

  it('英文与德文问句同样命中', () => {
    expect(retrieveServerGrounding('How do I create an API key?', 'en-US')[0].href).toBe('/docs/getting-started/api-keys');
    expect(retrieveServerGrounding('API-Schlüssel erstellen', 'de-DE')[0].href).toBe('/de/docs/getting-started/api-keys');
  });

  it('★线上问句「策略模块是什么样的？」有站内依据（不再是空 grounding）', () => {
    expect(retrieveServerGrounding('策略模块是什么样的？', 'zh-CN').length).toBeGreaterThan(0);
  });

  it('hi 无文档索引：回退 en 内容与无前缀路由（不拼出 /hi/docs 404）', () => {
    const hits = retrieveServerGrounding('API key', 'hi-IN');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.href.startsWith('/hi/docs'))).toBe(false);
  });

  it('给出 absoluteOrigin 时站内链接绝对化，站外链接不变', () => {
    const hits = retrieveServerGrounding('API 密钥', 'zh', { absoluteOrigin: 'https://aster-lang.cloud' });
    expect(hits[0].href).toBe('https://aster-lang.cloud/zh/docs/getting-started/api-keys');
    expect(hits.every((h) => h.href.startsWith('https://'))).toBe(true);
  });

  it('形状与条数上限与 aster-api 契约一致；空问句无命中', () => {
    const hits = retrieveServerGrounding('策略', 'zh');
    expect(hits.length).toBeLessThanOrEqual(MAX_GROUNDING_HITS);
    for (const h of hits) expect(Object.keys(h).sort()).toEqual(['href', 'snippet', 'title']);
    expect(retrieveServerGrounding('   ', 'zh')).toEqual([]);
  });
});
