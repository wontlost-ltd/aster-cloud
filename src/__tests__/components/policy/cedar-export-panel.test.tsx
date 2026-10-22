// 策略详情页「导出为 Cedar」面板（ADR 0047 §6）：可导出时按响应原样下载两个文件（文件名取编译器给出的模块名）
// 并报告探针比对数；不可导出时列出诊断；无可执行版本（409）时提示先批准；忙时显示服务端消息；其余失败显示通用失败文案。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CedarExportPanel } from '@/components/policy/cedar-export-panel';

const labels = {
  button: 'Export to Cedar',
  exporting: 'Exporting…',
  verified: 'Verified against Cedar on {count} probes',
  notExportable: 'This policy cannot be exported to Cedar',
  failed: 'Export failed',
  noExecutableVersion: 'Approve a version before exporting to Cedar',
  versionsLink: 'Version history',
  schemaNote: 'Schema covers only what the rule mentions',
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let downloads: { name: string; href: string }[];
let blobs: Blob[];

beforeEach(() => {
  downloads = [];
  blobs = [];
  createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return `blob:${blobs.length}`; });
  revokeObjectURL = vi.fn();
  Object.assign(URL, { createObjectURL, revokeObjectURL });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push({ name: this.download, href: this.getAttribute('href') ?? '' });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function renderPanel() {
  render(<CedarExportPanel policyId="p1" labels={labels} hasExecutableVersion versionsHref="/zh/policies/p1/versions" />);
  fireEvent.click(screen.getByRole('button', { name: 'Export to Cedar' }));
}

describe('CedarExportPanel', () => {
  // 键序刻意与 JS 重序列化不同（整数形态键 "1" 会被 JSON.stringify 提前），并含大写 \u001F 转义与空白
  const schemaText = '{"Aster":{"actions":{"read":{},"1":{}},"note":"a\\u001Fb"}}';

  it('exportable: POSTs to the owner route, downloads both files verbatim under moduleName, reports probes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      exportable: true, moduleName: 'finance.loan', policies: 'permit(principal, action, resource);',
      schema: JSON.parse(schemaText), schemaText, probes: { count: 4, agreed: 4 }, diagnostics: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();

    expect(await screen.findByText('Verified against Cedar on 4 probes')).toBeDefined();
    // 成功导出后同时提示 schema 收窄（ADR 0047 §5），避免网关按 schema 校验时的意外拒绝
    expect(screen.getByText('Schema covers only what the rule mentions')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/policies/p1/export/cedar', { method: 'POST' });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(downloads.map((d) => d.name)).toEqual(['finance.loan.cedar', 'finance.loan.cedarschema.json']);
    expect(blobs[0].type).toBe('text/plain');
    expect(await blobs[0].text()).toBe('permit(principal, action, resource);');
    expect(blobs[1].type).toBe('application/json');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('downloaded schema equals schemaText byte-for-byte (the audited schemaHash input), not a re-serialisation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      exportable: true, moduleName: 'm', policies: 'p', schema: JSON.parse(schemaText), schemaText,
      probes: { count: 1, agreed: 1 }, diagnostics: [],
    })));

    renderPanel();

    await screen.findByText('Verified against Cedar on 1 probes');
    const downloaded = await blobs[1].text();
    expect(downloaded).toBe(schemaText);
    expect(downloaded).not.toBe(JSON.stringify(JSON.parse(schemaText)));
  });

  it('falls back to "policy" file names when moduleName is absent', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      exportable: true, moduleName: null, policies: 'p', schema: {}, schemaText: '{}', probes: { count: 1, agreed: 1 }, diagnostics: [],
    })));

    renderPanel();

    await screen.findByText('Verified against Cedar on 1 probes');
    expect(downloads.map((d) => d.name)).toEqual(['policy.cedar', 'policy.cedarschema.json']);
  });

  it('409 no executable version: asks to approve a version first; no downloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(409, { error: 'no executable version' })));

    renderPanel();

    expect(await screen.findByText('Approve a version before exporting to Cedar')).toBeDefined();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('not exportable: lists diagnostics with code, line and message; no downloads', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(200, {
      exportable: false, policies: null, schema: null,
      diagnostics: [{ severity: 'error', code: 'E721', message: 'unsupported construct', startLine: 7, startColumn: 3, endLine: 7, endColumn: 9 }],
    })));

    renderPanel();

    expect(await screen.findByText('This policy cannot be exported to Cedar')).toBeDefined();
    expect(screen.getByText('E721')).toBeDefined();
    expect(screen.getByText(/7:3/)).toBeDefined();
    expect(screen.getByText(/unsupported construct/)).toBeDefined();
    expect(createObjectURL).not.toHaveBeenCalled();
  });

  it('503 busy: shows the server message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(503, {
      error: 'cedar_export_busy', message: 'Cedar export is busy, retry shortly', concurrencyLimit: 2,
    })));

    renderPanel();

    expect(await screen.findByText('Cedar export is busy, retry shortly')).toBeDefined();
  });

  it('no approved version at render time: button disabled, hint explains approval and links to versions; no request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<CedarExportPanel policyId="p1" labels={labels} hasExecutableVersion={false} versionsHref="/zh/policies/p1/versions" />);

    const button = screen.getByRole('button', { name: 'Export to Cedar' });
    expect(button.hasAttribute('disabled')).toBe(true);
    const hint = screen.getByText('Approve a version before exporting to Cedar');
    expect(button.getAttribute('aria-describedby')).toBe(hint.id);
    expect(screen.getByRole('link', { name: /Version history/ }).getAttribute('href')).toBe('/zh/policies/p1/versions');
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('other non-2xx (500): shows the generic failed label as an alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(500, { error: 'boom' })));

    renderPanel();

    expect((await screen.findByRole('alert')).textContent).toBe('Export failed');
  });

  it('502 upstream failure: shows the failed label', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(502, { success: false, error: 'upstream down' })));

    renderPanel();

    expect(await screen.findByText('Export failed')).toBeDefined();
  });

  it('network error: shows the failed label and re-enables the button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));

    renderPanel();

    expect(await screen.findByText('Export failed')).toBeDefined();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export to Cedar' }).hasAttribute('disabled')).toBe(false));
  });
});
