import { describe, expect, it } from 'vitest';
import { decisionLabelKey } from './decision-label';
import { sourceFilterToQuery } from './logs-content';

describe('decisionLabelKey', () => {
  it('shows rejection and engine error as separate decisions', () => {
    expect(decisionLabelKey('denied', false)).toBe('denied');
    expect(decisionLabelKey('error', false)).toBe('error');
    expect(decisionLabelKey('approved', true)).toBe('approved');
    expect(decisionLabelKey(null, false)).toBe('error');
  });
});

describe('日志来源筛选映射', () => {
  it('将 Web、API 和 CLI 标签映射到数据库枚举', () => {
    expect(sourceFilterToQuery('WEB')).toBe('dashboard');
    expect(sourceFilterToQuery('API')).toBe('api');
    expect(sourceFilterToQuery('CLI')).toBe('cli');
  });
});
