// 策略详情页档案徽标（ADR 0046 §6）：编译响应带 profile 才显示，标题按 locale 取自注册表。
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { PolicyProfileBadge } from '@/components/policy/policy-profile-badge';

const originalFetch = global.fetch;

function mockCompile(body: unknown, ok = true) {
  const fetchMock = vi.fn().mockResolvedValue({ ok, json: async () => body });
  global.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe('PolicyProfileBadge', () => {
  it('编译响应带 profile → 显示按 locale 的档案标题，并以源码 locale 请求编译', async () => {
    const fetchMock = mockCompile({ success: true, profile: 'eu-ai-act-high-risk' });
    render(<PolicyProfileBadge source="Module X." sourceLocale="de-DE" locale="zh" label="治理档案" />);
    await waitFor(() => expect(screen.getByText('欧盟人工智能法高风险系统')).toBeTruthy());
    expect(screen.getByText('治理档案')).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/policies/compile');
    expect(JSON.parse(init.body)).toEqual({ source: 'Module X.', locale: 'de-DE' });
  });

  it('编译响应无 profile → 不渲染', async () => {
    const fetchMock = mockCompile({ success: true });
    const { container } = render(<PolicyProfileBadge source="Module X." sourceLocale="en-US" locale="en" label="Profile" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('编译请求失败 → 不渲染、不抛错', async () => {
    const fetchMock = mockCompile({ error: 'x' }, false);
    const { container } = render(<PolicyProfileBadge source="Module X." sourceLocale="en-US" locale="en" label="Profile" />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});
