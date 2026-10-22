// F28：助手答复里的 Markdown 链接解析与 href 白名单。
import { describe, it, expect } from 'vitest';
import { classifyAnswerHref, parseAnswerLinks } from '@/lib/assistant/answer-links';

describe('parseAnswerLinks', () => {
  it('★线上原文：站内链接解析为 internal 链接', () => {
    expect(parseAnswerLinks('请前往 [/zh/settings/api-keys](/zh/settings/api-keys) 创建。')).toEqual([
      { kind: 'text', text: '请前往 ' },
      { kind: 'link', text: '/zh/settings/api-keys', href: '/zh/settings/api-keys', internal: true },
      { kind: 'text', text: ' 创建。' },
    ]);
  });

  it('站外 https 链接解析为 external', () => {
    const [seg] = parseAnswerLinks('[文档](https://www.aster-lang.dev/zh/docs/x)');
    expect(seg).toEqual({ kind: 'link', text: '文档', href: 'https://www.aster-lang.dev/zh/docs/x', internal: false });
  });

  it('★javascript: / data: / 协议相对 / 相对路径不生成链接，只保留标题', () => {
    for (const href of ['javascript:alert%281%29', 'JavaScript:void0', 'data:text/html,x', '//evil.com/x', '/\\evil.com', 'settings/api-keys']) {
      expect(parseAnswerLinks(`看 [这里](${href}) 吧`)).toEqual([{ kind: 'text', text: '看 这里 吧' }]);
    }
  });

  it('没有链接时原样返回单个文本段；空串返回空数组', () => {
    expect(parseAnswerLinks('无法确定。')).toEqual([{ kind: 'text', text: '无法确定。' }]);
    expect(parseAnswerLinks('')).toEqual([]);
  });

  it('流式中途未闭合的链接按原文显示', () => {
    expect(parseAnswerLinks('见 [API 密钥](/zh/sett')).toEqual([{ kind: 'text', text: '见 [API 密钥](/zh/sett' }]);
  });

  it('多个链接按顺序解析', () => {
    const segs = parseAnswerLinks('[a](/a) 与 [b](/b)');
    expect(segs.filter((s) => s.kind === 'link').map((s) => s.kind === 'link' && s.href)).toEqual(['/a', '/b']);
  });
});

describe('classifyAnswerHref', () => {
  it('http 也接受（站外引用），其余协议拒绝', () => {
    expect(classifyAnswerHref('http://example.com/')?.internal).toBe(false);
    expect(classifyAnswerHref('mailto:a@b.c')).toBeNull();
    expect(classifyAnswerHref('vbscript:x')).toBeNull();
  });
});
