import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';

/**
 * /policies 列表含团队策略后的展示与操作门控：
 *   - 团队策略行显示所属团队标签，个人策略不显示；
 *   - 「归属」筛选（全部 / 个人 / 各团队）写入 URL 参数 scope；
 *   - 操作按钮按服务端下发的 capabilities（authorizePolicyActions 判定）禁用，不看 userId；
 *   - 团队策略不可拖进侧栏的个人分组（canPlaceInGroup），故不渲染拖拽手柄。
 */

const replace = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn(), back: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => '/zh/policies',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => Object.assign((k: string) => k, { rich: (k: string) => k, raw: (k: string) => k, has: () => true }),
  useLocale: () => 'zh',
}));
vi.mock('lucide-react', async () => ({ ...(await vi.importActual<Record<string, unknown>>('lucide-react')) }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock('@/components/policy/policy-group-tree', () => ({ PolicyGroupTree: () => null }));
vi.mock('@/components/policy/policy-group-dialog', () => ({ PolicyGroupDialog: () => null }));
vi.mock('@/components/policy/shared-with-me-section', () => ({ SharedWithMeSection: () => null }));

import { PoliciesContent } from '@/app/[locale]/(dashboard)/policies/policies-content';

const strings = {
  title: 'title', subtitle: 's', newPolicy: 'new', trash: 'trash', failedToLoad: 'f', failedToDelete: 'f', confirmDelete: 'c',
  freeze: { title: 'ft', messageTemplate: 'm', upgradeLink: 'u', badge: 'frozen', cannotExecute: 'ce', cannotEdit: 'ced' },
  noPolicies: 'none', getStarted: 'g', piiFieldsTemplate: '{count}', public: 'public', executionsTemplate: '{count} runs',
  executeAction: 'Execute', edit: 'Edit', delete: 'Delete', updatedTemplate: '{date}',
  groups: new Proxy({}, { get: () => 'x' }),
} as never;

const ALL = { execute: true, update: true, delete: true };
const base = {
  description: null, content: 'c', isPublic: false, piiFields: null, groupId: null, group: null,
  createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', isFrozen: false, _count: { executions: 0 },
};
const POLICIES = [
  { ...base, id: 'p-personal', name: 'Mine', team: null, capabilities: ALL },
  { ...base, id: 'p-team-ro', name: 'Teammate', team: { id: 't1', name: 'Risk Team' }, capabilities: { execute: false, update: false, delete: false } },
  { ...base, id: 'p-team-rw', name: 'Editable', team: { id: 't1', name: 'Risk Team' }, capabilities: { execute: true, update: true, delete: false } },
];

function renderContent(scope: string | null = null) {
  return render(
    <PoliciesContent
      initialPolicies={POLICIES}
      initialGroups={[]}
      freezeInfo={{ limit: 10, total: 1, frozenCount: 0 }}
      translations={strings}
      locale="zh"
      sharingEnabled={false}
      teams={[{ id: 't1', name: 'Risk Team' }, { id: 't2', name: 'Ops' }]}
      pagination={{ page: 1, pageSize: 25, total: 3, selectedGroupId: null, query: '', scope }}
    />,
  );
}

const row = (name: string) => screen.getByText(name).closest('li')!;

beforeEach(() => { cleanup(); replace.mockReset(); });

describe('PoliciesContent 团队策略', () => {
  it('团队策略行显示团队标签，个人策略不显示', () => {
    renderContent();
    expect(within(row('Teammate')).getByText('Risk Team')).toBeTruthy();
    expect(within(row('Mine')).queryByText('Risk Team')).toBeNull();
  });

  it('归属筛选：选项为 全部 / 个人 / 各团队，切换写入 scope 参数', () => {
    renderContent();
    const select = screen.getByLabelText('teamFilter.label') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['teamFilter.all', 'teamFilter.personal', 'Risk Team', 'Ops']);
    fireEvent.change(select, { target: { value: 'personal' } });
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining('scope=personal'), expect.anything());
    fireEvent.change(select, { target: { value: 't2' } });
    expect(replace).toHaveBeenLastCalledWith(expect.stringContaining('scope=t2'), expect.anything());
  });

  it('当前筛选从 URL 状态回显', () => {
    renderContent('t1');
    expect((screen.getByLabelText('teamFilter.label') as HTMLSelectElement).value).toBe('t1');
  });

  it('无权限的操作被禁用：执行不是链接、不显示编辑、删除按钮 disabled', () => {
    renderContent();
    const ro = within(row('Teammate'));
    expect(ro.getByText('Execute').closest('a')).toBeNull();
    expect(ro.queryByText('Edit')).toBeNull();
    expect((ro.getByText('Delete') as HTMLButtonElement).disabled).toBe(true);

    const rw = within(row('Editable'));
    expect(rw.getByText('Execute').closest('a')).not.toBeNull();
    expect(rw.getByText('Edit').closest('a')).not.toBeNull();
    expect((rw.getByText('Delete') as HTMLButtonElement).disabled).toBe(true);

    const mine = within(row('Mine'));
    expect((mine.getByText('Delete') as HTMLButtonElement).disabled).toBe(false);
  });

  it('团队策略不渲染拖拽手柄（侧栏只有个人分组，canPlaceInGroup 不允许放入）', () => {
    renderContent();
    expect(row('Teammate').querySelector('[data-drag-handle]')).toBeNull();
    expect(row('Mine').querySelector('[data-drag-handle]')).not.toBeNull();
  });
});
