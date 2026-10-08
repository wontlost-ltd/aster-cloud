/*
 * ApiKeysContent 作用域行为（ADR 0015 §6）：
 *   - 选团队作用域 → POST 体带 teamId；列表作用域列显示团队名
 *   - 默认个人作用域 → POST 体不带 teamId；个人 key 行显示 scopePersonal
 *   - 403 not_a_member / plan_no_api_access → 显示本地化文案，而非原始错误码
 *   - 团队名按字面插入作用域选项，`$` 不被当作替换模式解释
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { ApiKeysContent } from '@/app/[locale]/(dashboard)/settings/api-keys/api-keys-content';

// 测试翻译对象：各键取互不相同的值，保证按文案定位元素不产生歧义
const T = {
  breadcrumb: 'API keys crumb',
  title: 'API Keys',
  subtitle: 'Manage your API keys',
  keyCreated: 'Key created',
  copyWarning: 'Copy it now',
  copy: 'Copy',
  dismiss: 'Dismiss',
  createNew: 'Create new API key',
  keyPlaceholder: 'Key name',
  creating: 'Creating…',
  createKey: 'Create key',
  enterName: 'Please enter a name',
  confirmRevoke: 'Revoke this key?',
  yourKeys: 'Your keys',
  noKeys: 'No keys yet',
  name: 'Name',
  key: 'Key',
  lastUsed: 'Last used',
  created: 'Created',
  actions: 'Actions',
  never: 'Never',
  revoke: 'Revoke',
  usageExample: 'Usage example',
  usageDescription: 'How to call the API',
  scope: 'Key scope',
  scopePersonal: 'Personal',
  scopeTeam: 'Team · {team}',
  scopeColumn: 'Scope column',
  errorNotMember: 'You are not a member of this team.',
  errorPlanNoApiAccess: 'The team owner’s plan does not include API access.',
  examples: {
    getPolicyId: 'Get policy id',
    getPolicyIdDesc: 'Find the policy id',
    executePolicy: 'Execute policy',
    executePolicyDesc: 'Evaluate a policy',
    listPolicies: 'List policies',
    listPoliciesDesc: 'List policy versions',
    responseExample: 'Response example',
    responseExampleDesc: 'Response shape',
    errorHandling: 'Error handling',
    errorHandlingDesc: 'Error codes',
    error401: 'Unauthorized',
    error403: 'Forbidden',
    error404: 'Not found',
    error429: 'Too many requests',
  },
  nav: { settings: 'Settings' },
  cancel: 'Cancel',
};

const originalFetch = global.fetch;

afterEach(() => {
  cleanup();
  global.fetch = originalFetch;
});

describe('ApiKeysContent — 作用域', () => {
  it('选择团队作用域后 POST 体带 teamId，列表显示团队名', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'ak_x', id: 'k9' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ([{ id: 'k9', name: 'n', prefix: 'abcdefgh', teamId: 't1', teamName: 'Team One', lastUsedAt: null, createdAt: new Date().toISOString(), expiresAt: null }]) }) as never;
    render(<ApiKeysContent initialApiKeys={[]} teams={[{ id: 't1', name: 'Team One' }]} translations={T} locale="en" />);
    fireEvent.change(screen.getByLabelText(T.scope), { target: { value: 't1' } });
    fireEvent.change(screen.getByLabelText(T.createNew), { target: { value: 'n' } });
    fireEvent.submit(screen.getByRole('button', { name: T.createKey }).closest('form')!);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/api-keys', expect.objectContaining({ body: JSON.stringify({ name: 'n', teamId: 't1' }) })));
    expect(await screen.findByText('Team One')).toBeInTheDocument();
  });

  it('未选团队时 POST 体不带 teamId；个人 key 行显示 scopePersonal', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ key: 'ak_x', id: 'k1' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ([{ id: 'k1', name: 'n', prefix: 'abcdefgh', teamId: null, teamName: null, lastUsedAt: null, createdAt: new Date().toISOString(), expiresAt: null }]) }) as never;
    render(<ApiKeysContent initialApiKeys={[]} teams={[{ id: 't1', name: 'Team One' }]} translations={T} locale="en" />);
    fireEvent.change(screen.getByLabelText(T.createNew), { target: { value: 'n' } });
    fireEvent.submit(screen.getByRole('button', { name: T.createKey }).closest('form')!);
    await waitFor(() => expect(global.fetch).toHaveBeenCalledWith('/api/api-keys', expect.objectContaining({ body: JSON.stringify({ name: 'n' }) })));
    // 下拉选项同样是 scopePersonal，故限定在列表表格内断言作用域单元格
    expect(within(await screen.findByRole('table')).getByText(T.scopePersonal)).toBeInTheDocument();
  });

  it('403 not_a_member → 显示 errorNotMember 文案', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'not_a_member' }) }) as never;
    render(<ApiKeysContent initialApiKeys={[]} teams={[{ id: 't1', name: 'Team One' }]} translations={T} locale="en" />);
    fireEvent.change(screen.getByLabelText(T.scope), { target: { value: 't1' } });
    fireEvent.change(screen.getByLabelText(T.createNew), { target: { value: 'n' } });
    fireEvent.submit(screen.getByRole('button', { name: T.createKey }).closest('form')!);
    expect(await screen.findByText(T.errorNotMember)).toBeInTheDocument();
  });

  it('403 plan_no_api_access → 显示 errorPlanNoApiAccess 文案', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, json: async () => ({ error: 'plan_no_api_access', upgrade: true }) }) as never;
    render(<ApiKeysContent initialApiKeys={[]} teams={[{ id: 't1', name: 'Team One' }]} translations={T} locale="en" />);
    fireEvent.change(screen.getByLabelText(T.scope), { target: { value: 't1' } });
    fireEvent.change(screen.getByLabelText(T.createNew), { target: { value: 'n' } });
    fireEvent.submit(screen.getByRole('button', { name: T.createKey }).closest('form')!);
    expect(await screen.findByText(T.errorPlanNoApiAccess)).toBeInTheDocument();
  });

  it('团队名含 $ 模式时按字面渲染作用域选项', () => {
    render(<ApiKeysContent initialApiKeys={[]} teams={[{ id: 't1', name: 'A$&B' }]} translations={T} locale="en" />);
    expect(screen.getByRole('option', { name: 'Team · A$&B' })).toBeInTheDocument();
  });
});
