// @vitest-environment jsdom
/**
 * #774：命令面板触发按钮的 aria-label（"Open command palette…"）与可见文字（"Search…"）不一致，
 * 违反 WCAG 2.5.3 Label in Name（axe label-content-name-mismatch，每个仪表盘页都出现）。
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => '/dashboard' }));
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
vi.mock('@/lib/mixpanel', () => ({ track: vi.fn(), Events: new Proxy({}, { get: (_t, k) => String(k) }) }));

import { CommandPalette } from '@/components/dashboard/command-palette';

const labels = {
  placeholder: 'Search or jump to…', noResults: 'No matches', groupNavigate: 'Navigate', groupPolicies: 'Policies',
  groupCreate: 'Create', groupSettings: 'Settings', groupDocs: 'Docs', groupAdmin: 'Admin', hintOpen: 'Open command palette',
};

describe('CommandPalette trigger (#774)', () => {
  it('derives its accessible name from the visible placeholder, not a divergent aria-label', () => {
    render(<CommandPalette commands={[]} labels={labels} />);
    const trigger = screen.getByRole('button', { name: /Search or jump to…/ });
    expect(trigger.hasAttribute('aria-label')).toBe(false);
    // 移动端占位文字隐藏时仍有名称（sr-only）
    expect(trigger.textContent).toContain('Open command palette');
    const kbd = trigger.querySelector('kbd');
    expect(kbd?.getAttribute('aria-hidden')).toBe('true');
    // ⌘K 由 CSS content 画出，不属于按钮的文字内容
    expect(kbd?.textContent).toBe('');
    expect(kbd?.getAttribute('data-shortcut')).toBe('⌘K');
    expect(trigger.textContent).not.toContain('⌘K');
  });
});
