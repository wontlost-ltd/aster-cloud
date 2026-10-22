/*
 * ConfirmDialog 包装（生产 E2E F32）：调用方未传按钮文案时用 common 命名空间的本地化文案，
 * 不再落到设计系统的英文缺省 'Confirm' / 'Cancel'；显式传入的文案优先。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';

const MESSAGES: Record<string, string> = { 'common.cancel': '取消', 'common.confirm': '确认' };
vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (key: string) => MESSAGES[`${ns}.${key}`] ?? key,
}));
vi.mock('@aster-cloud/ui', () => ({
  ConfirmDialog: ({ confirmLabel, cancelLabel, title }: { confirmLabel?: string; cancelLabel?: string; title: string }) => (
    <div>
      <h3>{title}</h3>
      <button type="button">{cancelLabel}</button>
      <button type="button">{confirmLabel}</button>
    </div>
  ),
}));

import { ConfirmDialog } from './confirm-dialog';

afterEach(cleanup);

const base = { isOpen: true, title: '永久删除', description: 'x', onConfirm: () => {}, onCancel: () => {} };

describe('ConfirmDialog（本地化包装）', () => {
  it('未传按钮文案：取消/确认用本地化缺省值', () => {
    render(<ConfirmDialog {...base} />);
    expect(screen.getByRole('button', { name: '取消' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '确认' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('显式传入的文案优先', () => {
    render(<ConfirmDialog {...base} confirmLabel="永久删除" cancelLabel="先不删" />);
    expect(screen.getByRole('button', { name: '先不删' })).toBeTruthy();
    expect(screen.getAllByText('永久删除').length).toBe(2);
  });
});
