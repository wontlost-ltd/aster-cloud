/*
 * 回收站永久删除确认（生产 E2E F32）：确认框点名被删除的策略，策略名按字面插入（含 $ 等特殊字符）；
 * 加载态文案来自翻译。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@/lib/format', () => ({ formatDate: (d: string) => d }));
vi.mock('@/components/ui', () => ({
  Container: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PageHeader: () => null,
  ConfirmDialog: ({ isOpen, description }: { isOpen: boolean; description: React.ReactNode }) =>
    isOpen ? <div role="dialog">{description}</div> : null,
}));

import { TrashContent } from './trash-content';

const translations = {
  trash: {
    title: '回收站', description: '', backToPolicies: '', empty: '回收站为空', emptyTrash: '清空回收站',
    confirmEmptyTrash: '', restore: '恢复', permanentDelete: '永久删除',
    confirmPermanentDelete: '确定要永久删除策略「{name}」吗？此操作无法撤销。',
    deletedAt: '删除于', expiresAt: '', reason: '', noReason: '', restoreSuccess: '', restoreWithNewName: '',
    deleteSuccess: '', emptySuccess: '', loadError: '', actionError: '', itemCount: '', daysRemaining: '{days} 天',
    loading: '加载中…',
  },
};

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    items: [{ id: 't1', policyId: 'p1', name: 'loan-$&-evaluation', description: null,
      deletedAt: '2026-10-20T00:00:00Z', expiresAt: '2026-11-19T00:00:00Z', daysRemaining: 27 }],
    stats: { total: 1, expiringWithin7Days: 0 },
  }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('TrashContent 永久删除确认', () => {
  it('加载态文案来自翻译', () => {
    render(<TrashContent translations={translations} locale="zh" />);
    expect(screen.getByText('加载中…')).toBeTruthy();
  });

  it('确认框点名被删除的策略', async () => {
    render(<TrashContent translations={translations} locale="zh" />);
    fireEvent.click(await screen.findByRole('button', { name: '永久删除' }));
    expect(screen.getByRole('dialog').textContent).toBe('确定要永久删除策略「loan-$&-evaluation」吗？此操作无法撤销。');
  });
});
