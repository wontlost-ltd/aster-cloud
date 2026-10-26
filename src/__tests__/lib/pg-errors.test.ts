import { describe, it, expect } from 'vitest';

import { isUndefinedTable, isUniqueViolation } from '@/lib/pg-errors';

describe('isUniqueViolation', () => {
  it('★drizzle 包装后的 postgres-js 错误：23505 在 cause 上', () => {
    const wrapped = Object.assign(new Error('Failed query: insert into "UsedNonce" ...'), {
      cause: Object.assign(new Error('duplicate key value violates unique constraint'), { code: '23505' }),
    });
    expect(isUniqueViolation(wrapped)).toBe(true);
  });

  it('顶层带 23505 也认', () => {
    expect(isUniqueViolation({ code: '23505' })).toBe(true);
  });

  it('其它 SQLSTATE 不算', () => {
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
    expect(isUniqueViolation({ cause: { code: '08006' } })).toBe(false);
  });

  it('非对象与无 code 不算', () => {
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation('23505')).toBe(false);
    expect(isUniqueViolation(new Error('boom'))).toBe(false);
  });
});

describe('isUndefinedTable', () => {
  it('drizzle 包装后的 42P01（cause 上）与顶层 42P01 都认', () => {
    const wrapped = Object.assign(new Error('Failed query: select ... from "UserVocabularyVersion"'), {
      cause: Object.assign(new Error('relation "UserVocabularyVersion" does not exist'), { code: '42P01' }),
    });
    expect(isUndefinedTable(wrapped)).toBe(true);
    expect(isUndefinedTable({ code: '42P01' })).toBe(true);
  });

  it('只认 SQLSTATE，不靠报错文本；其它错误码不算', () => {
    expect(isUndefinedTable(new Error('relation "X" does not exist'))).toBe(false);
    expect(isUndefinedTable({ code: '42703' })).toBe(false);
    expect(isUndefinedTable({ cause: { code: '23505' } })).toBe(false);
    expect(isUndefinedTable(null)).toBe(false);
  });
});
