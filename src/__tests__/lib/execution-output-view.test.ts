/**
 * 执行输出的日志面视图（cloud#772）：只对字符串叶子过 PIIRedactor 口径的正则。
 */
import { describe, it, expect } from 'vitest';
import { renderMaskedExecutionOutput } from '@/lib/execution-input/output-view';
import { redactInputString } from '@/lib/execution-input/input-view';

describe('renderMaskedExecutionOutput', () => {
  it('issue 示例："Hello, " + applicant.name 派生的句子里，正则能识别的部分被打码', () => {
    expect(renderMaskedExecutionOutput('Hello, John Smith! Reach me at john.smith@example.com or 555-123-4567.')).toBe(
      'Hello, John Smith! Reach me at ***@***.*** or (***) ***-****.',
    );
  });

  it('与输入面同一组正则：SSN / 邮箱 / 电话 / 信用卡 / IP', () => {
    const text = 'a 123-45-6789 b x@y.io c (555) 123-4567 d 4111 1111 1111 1111 e 10.0.0.1';
    expect(renderMaskedExecutionOutput(text)).toBe(redactInputString(text));
  });

  it('嵌套对象与数组：每个字符串叶子都被处理', () => {
    const out = renderMaskedExecutionOutput({
      result: { message: 'to a@b.co', tags: ['ok', 'ip 192.168.0.1', { deep: ['x@y.io'] }] },
      list: [['p 555-123-4567']],
    });
    expect(out).toEqual({
      result: { message: 'to ***@***.***', tags: ['ok', 'ip ***.***.***.***', { deep: ['***@***.***'] }] },
      list: [['p (***) ***-****']],
    });
  });

  it('非字符串叶子原样保留（数字、布尔、null）', () => {
    const input = { n: 1234567890, f: 1.5, t: true, nil: null, arr: [1, false, null] };
    expect(renderMaskedExecutionOutput(input)).toEqual(input);
    expect(renderMaskedExecutionOutput(42)).toBe(42);
    expect(renderMaskedExecutionOutput(null)).toBeNull();
  });

  it('空白串与规范 UUID 整串豁免；键名不动', () => {
    const uuid = '123e4567-e89b-12d3-a456-426614174000';
    expect(renderMaskedExecutionOutput({ 'a@b.co': ' ', id: uuid })).toEqual({ 'a@b.co': ' ', id: uuid });
  });

  it('不修改入参', () => {
    const input = { m: 'x@y.io' };
    renderMaskedExecutionOutput(input);
    expect(input.m).toBe('x@y.io');
  });

  it('病态深度：超过上限的子树整体替换为占位串而非递归到底', () => {
    let deep: unknown = 'x@y.io';
    for (let i = 0; i < 100; i++) deep = { n: deep };
    const text = JSON.stringify(renderMaskedExecutionOutput(deep));
    expect(text).toContain('[output too deep]');
    expect(text).not.toContain('x@y.io');
  });
});
