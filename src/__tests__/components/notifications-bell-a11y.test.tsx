// 通知铃铛无障碍（#814）：有未读数时按钮的可访问名必须包含徽章上的可见文字
// （WCAG 2.5.3 Label in Name / axe label-content-name-mismatch）。
// axe 的该规则依赖真实布局，jsdom 下只会给出 incomplete，所以这里直接断言
// 可访问名与可见文字的包含关系；真实浏览器里的 axe 校验由 UI 审计（种子带未读通知）覆盖。
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

const messages: Record<string, string> = {
  label: 'Notifications',
  labelWithUnread: 'Notifications, {count} unread',
};
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign(
    (key: string) => messages[key] ?? key,
    { raw: (key: string) => messages[key] ?? key },
  ),
}));
vi.mock('@/i18n/navigation', () => ({
  Link: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => React.createElement('a', { href, ...props }, children),
}));

import { NotificationsBell, fillTemplate } from '@/components/notifications/notifications-bell';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { locales } from '@/i18n/config';

function stubCount(count: number) {
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ count }) })));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotificationsBell 可访问名（#814）', () => {
  it.each([
    [3, '3'],
    [51, '50+'],
  ])('未读 %i 条：徽章显示 %s，且可访问名包含它', async (count, visible) => {
    stubCount(count);
    render(<NotificationsBell />);
    const button = await screen.findByRole('button', { name: `Notifications, ${visible} unread` });
    const visibleText = (button.textContent ?? '').trim();
    expect(visibleText).toBe(visible);
    expect(button.getAttribute('aria-label')).toContain(visibleText);
  });

  it('无未读：不显示徽章，可访问名是「Notifications」', async () => {
    stubCount(0);
    render(<NotificationsBell />);
    const button = await screen.findByRole('button', { name: 'Notifications' });
    expect((button.textContent ?? '').trim()).toBe('');
  });

  it.each(locales)('%s：labelWithUnread 代入 3 / 50+ 后可访问名包含徽章原文', (locale) => {
    const template = (DEMO_SUPPLEMENT[locale].notifications as Record<string, string>).labelWithUnread;
    expect(template).toContain('{count}');
    for (const badge of ['3', '50+']) {
      const name = fillTemplate(template, { count: badge });
      expect(name).toContain(badge);
      expect(name).not.toContain('{count}');
    }
  });
});
