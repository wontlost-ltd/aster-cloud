// 四眼原则单一判定（approveVersion、版本页与审批收件箱共用）。
import { describe, it, expect } from 'vitest';
import { isSelfApproval } from '@/services/policy/version-approval-rules';

describe('isSelfApproval', () => {
  it('审批人是版本作者 → 自审', () => {
    expect(isSelfApproval('u1', 'u1')).toBe(true);
  });

  it('审批人不是作者，或作者未知 → 非自审', () => {
    expect(isSelfApproval('u2', 'u1')).toBe(false);
    expect(isSelfApproval(null, 'u1')).toBe(false);
    expect(isSelfApproval(undefined, 'u1')).toBe(false);
  });
});
