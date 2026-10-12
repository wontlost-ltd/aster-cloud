// 策略详情页「导出为 Cedar」面板（ADR 0047 §6）：可导出时下载两个文件并报告探针比对数；
// 不可导出时列出诊断；忙时显示服务端消息；其余失败显示通用失败文案。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CedarExportPanel, cedarModuleName } from '@/components/policy/cedar-export-panel';

const labels = {
  button: 'Export to Cedar',
  exporting: 'Exporting…',
  verified: 'Verified against Cedar on {count} probes',
  notExportable: 'This policy cannot be exported to Cedar',
  failed: 'Export failed',
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
  render(<CedarExportPanel policyId="p1" moduleName="finance.loan" labels={labels} />);
  fireEvent.click(screen.getByRole('button', { name: 'Export to Cedar' }));
}

describe('CedarExportPanel', () => {
  it('exportable: POSTs to the owner route, downloads both files, reports probes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, {
      exportable: true, policies: 'permit(principal, action, resource);', schema: { ns: { entityTypes: {} } },
      probes: { count: 4, agreed: 4 }, diagnostics: [],
    }));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel();

    expect(await screen.findByText('Verified against Cedar on 4 probes')).toBeDefined();
    expect(fetchMock).toHaveBeenCalledWith('/api/policies/p1/export/cedar', { method: 'POST' });
    expect(createObjectURL).toHaveBeenCalledTimes(2);
    expect(downloads.map((d) => d.name)).toEqual(['finance.loan.cedar', 'finance.loan.cedarschema.json']);
    expect(blobs[0].type).toBe('text/plain');
    expect(await blobs[0].text()).toBe('permit(principal, action, resource);');
    expect(blobs[1].type).toBe('application/json');
    // 紧凑序列化：与 aster-api 审计 POLICY_EXPORTED 的 schemaHash 同一字节，下载文件可直接按哈希对账
    expect(await blobs[1].text()).toBe('{"ns":{"entityTypes":{}}}');
    expect(revokeObjectURL).toHaveBeenCalledTimes(2);
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

describe('cedarModuleName', () => {
  it('reads the module declaration in en/de/zh', () => {
    expect(cedarModuleName('Module finance.loan.\n\nRule x given a: Int, produce Bool:')).toBe('finance.loan');
    expect(cedarModuleName('Modul finanz.kredit.\n')).toBe('finanz.kredit');
    expect(cedarModuleName('模块 金融.贷款。\n')).toBe('金融.贷款');
  });

  it('falls back to "policy" when there is no module declaration', () => {
    expect(cedarModuleName('if x then y')).toBe('policy');
  });
});
