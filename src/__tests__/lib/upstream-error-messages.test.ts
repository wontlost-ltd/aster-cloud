import { describe, it, expect } from 'vitest';
import { upstreamErrorMessage, withEnglishWindowLabel } from '@/lib/upstream-error-messages';

/** aster-api 中文错误提示按错误码换成英文（#680 / 审查 L1）。 */
describe('upstreamErrorMessage', () => {
  const guardCodes: Array<[string, string]> = [
    ['role_mismatch', '该审批需要业务角色: Credit Officer'],
    ['comment_required', '拒绝必须填写 comment'],
    ['approval_not_found', '审批不存在: a1'],
    ['receipt_unavailable', '审批事件写入审计链失败，请稍后重试'],
    ['invalid_approval', '审批人标识须为 1–128 字符'],
    ['user_required', '审批需要已验证的用户身份'],
    ['segregation_of_duties', '动作的发起主体或提交方不能审批该动作'],
    ['approval_not_pending', '审批已处理或已过期: a1'],
    ['whatif_not_entitled', 'What-If 影响估算需 Pro 及以上套餐'],
    ['whatif_batch_in_progress', '已有批次在运行，完成后可再发起'],
  ];

  it.each(guardCodes)('%s → 英文，不含中文', (code, zh) => {
    const msg = upstreamErrorMessage(code, zh);
    expect(msg).not.toBe(zh);
    expect(msg).not.toMatch(/[一-鿿]/);
  });

  it('未登记的错误码原样透传', () => {
    expect(upstreamErrorMessage('something_else', 'raw')).toBe('raw');
    expect(upstreamErrorMessage(undefined, 'raw')).toBe('raw');
  });

  it('windowLabel 按 windowKind 换英文；未知 kind 不动', () => {
    expect(withEnglishWindowLabel({ windowKind: 'LAST_QUARTER', windowLabel: '最近一个季度' })).toEqual({
      windowKind: 'LAST_QUARTER',
      windowLabel: 'Last quarter',
    });
    expect(withEnglishWindowLabel({ windowKind: 'X', windowLabel: 'y' })).toEqual({ windowKind: 'X', windowLabel: 'y' });
  });
});
