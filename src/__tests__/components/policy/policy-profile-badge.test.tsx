// 策略详情页档案徽标（ADR 0046 §6）：档案取自保存时落库的 PolicyVersion.profile，不发编译请求。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { PolicyProfileBadge } from '@/components/policy/policy-profile-badge';

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe('PolicyProfileBadge', () => {
  it('有 profile → 显示按 locale 的注册表标题，且不发任何请求', () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    render(<PolicyProfileBadge profile="eu-ai-act-high-risk" locale="zh" label="治理档案" />);
    expect(screen.getByText('欧盟人工智能法高风险系统')).toBeTruthy();
    expect(screen.getByText('治理档案')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('profile 为 null（未声明或旧版本）→ 不渲染', () => {
    const { container } = render(<PolicyProfileBadge profile={null} locale="en" label="Profile" />);
    expect(container.textContent).toBe('');
  });

  it('未知档案 id → 以 id 作标题', () => {
    render(<PolicyProfileBadge profile="custom-x" locale="en" label="Profile" />);
    expect(screen.getByText('custom-x')).toBeTruthy();
  });
});
