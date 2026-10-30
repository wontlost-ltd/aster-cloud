// 操作失败文案与错误码的提取（#662 审查）：三种响应形状都只返回字符串或 null。
import { describe, it, expect } from 'vitest';
import { actionErrorCode, actionErrorMessage } from '@/lib/api/error-envelope';

const envelope = { error: { code: 'internal_error', message: 'Could not archive version.', requestId: 'r1' } };

describe('actionErrorMessage', () => {
  it('顶层 message 优先', () => {
    expect(actionErrorMessage({ ...envelope, message: 'top' })).toBe('top');
    expect(actionErrorMessage({ error: 'segregation_of_duties', message: 'human' })).toBe('human');
  });
  it('结构化 envelope：取 error.message，不返回对象', () => {
    expect(actionErrorMessage(envelope)).toBe('Could not archive version.');
  });
  it('旧式字符串 error', () => {
    expect(actionErrorMessage({ error: 'Invalid version number.' })).toBe('Invalid version number.');
  });
  it('无可读文案 → null', () => {
    expect(actionErrorMessage({ error: { code: 'x' } })).toBeNull();
    expect(actionErrorMessage({ message: '  ' })).toBeNull();
    expect(actionErrorMessage(null)).toBeNull();
    expect(actionErrorMessage('oops')).toBeNull();
  });
});

describe('actionErrorCode', () => {
  it('顶层 code → 字符串 error → envelope 的 error.code', () => {
    expect(actionErrorCode({ code: 'default_version_locked', error: 'msg' })).toBe('default_version_locked');
    expect(actionErrorCode({ error: 'segregation_of_duties' })).toBe('segregation_of_duties');
    expect(actionErrorCode(envelope)).toBe('internal_error');
    expect(actionErrorCode({})).toBeNull();
  });
});
