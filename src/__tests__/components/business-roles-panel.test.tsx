// 业务角色编辑器（ADR 0042 §2.1）：非编辑态跟随父组件重新拉取的角色；编辑中不被 props 变化打断。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BusinessRolesEditor, type BusinessRolesEditorLabels } from '@/components/settings/business-roles-panel';

const labels: BusinessRolesEditorLabels = {
  none: 'none', edit: 'edit', placeholder: 'roles', hint: 'hint', save: 'save', saving: 'saving',
  cancel: 'cancel', invalid: 'invalid', saveFailed: 'failed',
};

const onSave = async (roles: string[]) => roles;

afterEach(cleanup);

describe('BusinessRolesEditor', () => {
  it('非编辑态：父组件传入新角色 → chip 随之刷新', () => {
    const { rerender } = render(<BusinessRolesEditor roles={['DPO']} canEdit onSave={onSave} labels={labels} />);
    expect(screen.getByText('DPO')).toBeTruthy();

    rerender(<BusinessRolesEditor roles={['CISO', 'DPO']} canEdit onSave={onSave} labels={labels} />);
    expect(screen.getByText('CISO')).toBeTruthy();
    expect(screen.getByText('DPO')).toBeTruthy();

    rerender(<BusinessRolesEditor roles={[]} canEdit onSave={onSave} labels={labels} />);
    expect(screen.getByText('none')).toBeTruthy();
  });

  it('同内容的新数组不触发重复同步；编辑中 props 变化不覆盖草稿', () => {
    const { rerender } = render(<BusinessRolesEditor roles={['DPO']} canEdit onSave={onSave} labels={labels} />);
    rerender(<BusinessRolesEditor roles={['DPO']} canEdit onSave={onSave} labels={labels} />);
    expect(screen.getByText('DPO')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'edit' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'DPO, Auditor' } });
    rerender(<BusinessRolesEditor roles={['CISO']} canEdit onSave={onSave} labels={labels} />);
    expect((screen.getByRole('textbox') as HTMLInputElement).value).toBe('DPO, Auditor');

    // 取消编辑后回到非编辑态，显示父组件最新的角色
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(screen.getByText('CISO')).toBeTruthy();
  });
});
