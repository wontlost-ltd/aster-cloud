// 设置页 BYOK 模型字段（ADR 0048）：可选模型输入、POST/PATCH 携带 model、
// 400 model_not_available 回显可用列表、未校验提示的生命周期、已绑定列表的模型列。
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { AiKeysContent } from '@/app/[locale]/(dashboard)/settings/ai-keys/ai-keys-content';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';
import { deepMergeMessages } from '@/i18n/request';

const pkgEn = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../node_modules/@aster-cloud/ui-messages/en-US.json'),
    'utf8',
  ),
);
const messages = deepMergeMessages(pkgEn, DEMO_SUPPLEMENT.en);

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      {children}
    </NextIntlClientProvider>
  );
}

const baseBinding = {
  providerUrl: null,
  tokenQuota: null,
  expiresAt: null,
  priority: 0,
  usedTokensThisMonth: 0,
  lastUsedAt: null,
  lastErrorAt: null,
  lastError: null,
  createdAt: '2026-01-01T00:00:00Z',
  active: true,
};

const jsonRes = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
// 每次调用返回新的 Response（body 只能读一次；保存后组件会再 GET 刷新列表）
const fetchReturning = (status: number, body: unknown) => vi.fn().mockImplementation(async () => jsonRes(status, body));

function fillAndSave(model?: string, key = 'x') {
  fireEvent.change(screen.getByLabelText('API key'), { target: { value: 'sk-'.padEnd(24, key) } });
  if (model !== undefined) {
    fireEvent.change(screen.getByLabelText('Model (optional)'), { target: { value: model } });
  }
  fireEvent.click(screen.getByText('Save key'));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AiKeysContent 模型字段', () => {
  it('表单含「模型（可选）」输入', () => {
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    expect(screen.getByLabelText('Model (optional)')).toBeDefined();
  });

  it('提交时把 model 发给 POST', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, id: 'b1', modelsChecked: true }));
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave('gpt-4o');
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBe('gpt-4o');
  });

  it('留空发 null', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, id: 'b1', modelsChecked: true }));
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave();
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body.model).toBeNull();
  });

  it('非法 model id 本地拒绝，不发请求', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave('bad model!');
    expect(await screen.findByText(/may only contain letters/)).toBeDefined();
    expect(f).not.toHaveBeenCalled();
  });

  it('400 model_not_available → 显示可用列表提示', async () => {
    vi.stubGlobal(
      'fetch',
      fetchReturning(400, { error: 'model_not_available', available: ['gpt-4o-mini'] }),
    );
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave('gpt-9');
    expect(await screen.findByText(/not available.*gpt-4o-mini/)).toBeDefined();
  });

  it('★400 provider_key_rejected → 本地化标题 + provider 原话，不显示成功', async () => {
    const msg = 'This API key is not scoped to a workspace, so this request must include the anthropic-workspace-id header with the ID of the workspace to use.';
    vi.stubGlobal('fetch', fetchReturning(400, { error: 'provider_key_rejected', reason: 'provider_bad_request', message: msg }));
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave();
    expect(await screen.findByText(/The provider rejected this API key, so it was not saved\. This API key is not scoped to a workspace/)).toBeDefined();
    expect(screen.queryByText(/Key saved/i)).toBeNull();
  });

  it('provider_key_rejected 无 message → 只显示标题', async () => {
    vi.stubGlobal('fetch', fetchReturning(400, { error: 'provider_key_rejected', reason: 'provider_auth_failed', message: null }));
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave();
    expect(await screen.findByText('The provider rejected this API key, so it was not saved.')).toBeDefined();
  });

  it('保存成功但 modelsChecked=false → 显示「未校验」提示，下次提交时清除', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, id: 'b1', modelsChecked: false }));
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave();
    expect(await screen.findByRole('status')).toHaveTextContent(/could not be verified/);
    // 第二次提交返回失败：notice 必须在提交开始时就被清掉
    vi.mocked(fetch).mockImplementation(async () => jsonRes(500, {}));
    fillAndSave(undefined, 'y');
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
  });

  it.each([
    ['provider_unavailable', /could not be verified.*rejected the key or is unavailable/],
    ['timeout', /could not be verified.*timed out/],
    ['endpoint_rejected', /could not be verified.*Provider URL or provider was rejected/],
  ])('保存成功但未校验（%s）→ 提示附带原因', async (reason, re) => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, id: 'b1', modelsChecked: false, unverifiedReason: reason }));
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave();
    expect(await screen.findByRole('status')).toHaveTextContent(re);
  });

  it('未知原因码 → 回落 unknown 文案，不显示 key 路径', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, id: 'b1', modelsChecked: false, unverifiedReason: 'weird' }));
    render(<AiKeysContent initialBindings={[]} locale="en" />, { wrapper });
    fillAndSave();
    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent(/unknown error/);
    expect(status.textContent).not.toContain('modelUnverifiedReason');
  });

  it('已绑定列表显示 model 列：指定值或「Platform default」', () => {
    render(
      <AiKeysContent
        locale="en"
        initialBindings={[
          { ...baseBinding, id: 'a', provider: 'openai', keyHint: '1234', model: 'gpt-4o', availableModels: null, modelsCheckedAt: null },
          {
            ...baseBinding,
            id: 'b',
            provider: 'anthropic',
            keyHint: '5678',
            model: null,
            availableModels: { models: null, defaultModel: 'claude-sonnet-5-5' },
            modelsCheckedAt: null,
          },
        ]}
      />,
      { wrapper },
    );
    expect(screen.getByText('gpt-4o')).toBeDefined();
    expect(screen.getByText('Platform default (claude-sonnet-5-5)')).toBeDefined();
  });

  it('行内编辑把 model 随 PATCH update 发出；清空发 null', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, bindings: [] }));
    render(
      <AiKeysContent
        locale="en"
        initialBindings={[
          { ...baseBinding, id: 'a', provider: 'openai', keyHint: '1234', model: 'gpt-4o', availableModels: null, modelsCheckedAt: null },
        ]}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByText('Edit'));
    // 行内编辑输入的 aria-label 与表单同为 t('model')；表单输入在前，行内输入在后
    const input = screen.getAllByLabelText('Model (optional)')[1] as HTMLInputElement;
    expect(input.value).toBe('gpt-4o');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ id: 'a', action: 'update', model: null });
  });
  it('行内仅改额度：PATCH 不带 model', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, bindings: [] }));
    render(
      <AiKeysContent
        locale="en"
        initialBindings={[
          { ...baseBinding, id: 'a', provider: 'openai', keyHint: '1234', model: 'gpt-4o', availableModels: null, modelsCheckedAt: null },
        ]}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByText('Edit'));
    const quota = screen.getAllByRole('spinbutton').pop() as HTMLInputElement;
    fireEvent.change(quota, { target: { value: '1000' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ id: 'a', action: 'update', tokenQuota: 1000 });
    expect('model' in body).toBe(false);
  });

  it('行内改模型：PATCH 带 model', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, bindings: [] }));
    render(
      <AiKeysContent
        locale="en"
        initialBindings={[
          { ...baseBinding, id: 'a', provider: 'openai', keyHint: '1234', model: 'gpt-4o', availableModels: null, modelsCheckedAt: null },
        ]}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getAllByLabelText('Model (optional)')[1] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-4o-mini' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const body = JSON.parse((vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string);
    expect(body).toMatchObject({ id: 'a', action: 'update', model: 'gpt-4o-mini' });
  });

  it('行内保存失败 → 错误以 role=alert 呈现', async () => {
    vi.stubGlobal('fetch', fetchReturning(400, { error: 'model_not_available', available: ['gpt-4o-mini'] }));
    render(
      <AiKeysContent
        locale="en"
        initialBindings={[
          { ...baseBinding, id: 'a', provider: 'openai', keyHint: '1234', model: 'gpt-4o', availableModels: null, modelsCheckedAt: null },
        ]}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getAllByLabelText('Model (optional)')[1] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-4o-mini' } });
    fireEvent.click(screen.getByText('Save'));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('gpt-4o-mini');
  });

  it('行内改模型保存成功但未校验 → 行内提示附带原因', async () => {
    vi.stubGlobal('fetch', fetchReturning(200, { ok: true, modelsChecked: false, unverifiedReason: 'provider_unavailable', bindings: [] }));
    render(
      <AiKeysContent
        locale="en"
        initialBindings={[
          { ...baseBinding, id: 'a', provider: 'openai', keyHint: '1234', model: 'gpt-4o', availableModels: null, modelsCheckedAt: null },
        ]}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByText('Edit'));
    const input = screen.getAllByLabelText('Model (optional)')[1] as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'gpt-4o-mini' } });
    fireEvent.click(screen.getByText('Save'));
    expect(await screen.findByRole('status')).toHaveTextContent(/could not be verified.*rejected the key or is unavailable/);
  });
});
