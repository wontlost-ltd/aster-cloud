import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * 策略包导出面板（ADR 0059 P2，T19）：下载结果（文件名取 Content-Disposition、SHA-256 可复制）、无签名提示、
 * 不可导出的诊断、入口选择与按状态 / 码本地化的错误文案。状态区常驻 aria-live。
 */

import { PolicyExportMenu } from '@/components/policy/policy-export-menu';
import { PackageExportProvider, PackageExportStatus } from '@/components/policy/package-export-panel';
import type { PackageExportMenuState } from '@/lib/package-export-state';
import { packageExportLabels as labels } from '@/__tests__/helpers/package-export-labels';

const packages = (over: Partial<PackageExportMenuState> = {}): PackageExportMenuState => ({
  jre: 'exportable', node: 'unavailable', diagnostics: { jre: [], node: [] }, entryRequired: false, entryCandidates: [], ...over,
});

function renderPanel(p = packages()) {
  return render(
    <PackageExportProvider policyId="p1" locale="en" labels={labels} packages={p}>
      <PolicyExportMenu showCedar={false} packages={p} labels={labels} />
      <PackageExportStatus />
    </PackageExportProvider>,
  );
}

const exportJre = () => {
  fireEvent.click(screen.getByTestId('policy-export-menu-button'));
  fireEvent.click(screen.getByTestId('export-item-jre'));
};

const zip = (headers: Record<string, string> = {}) => new Response(new Uint8Array([0x50, 0x4b, 3, 4]), {
  status: 200,
  headers: {
    'Content-Type': 'application/zip',
    'Content-Disposition': `attachment; filename="_-v2-jre-b.zip"; filename*=UTF-8''${encodeURIComponent('块.遮蔽-v2-jre-b.zip')}`,
    'X-Aster-Package-Sha256': 'ef'.repeat(32),
    'X-Aster-Package-Signed': 'true',
    ...headers,
  },
});
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let downloads: string[];
const writeText = vi.fn(async () => {});

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  downloads = [];
  URL.createObjectURL = vi.fn(() => 'blob:zip');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloads.push(this.download); });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('PackageExportPanel', () => {
  it('状态区常驻 aria-live=polite，空闲时为空', () => {
    renderPanel();
    const status = screen.getByTestId('package-export-status');
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.innerHTML).toBe('');
  });

  it('下载成功：文件名取 Content-Disposition（filename* 优先），状态区显示可复制的 SHA-256', async () => {
    fetchMock.mockResolvedValue(zip());
    renderPanel();
    exportJre();
    await screen.findByTestId('package-export-downloaded');
    expect(downloads).toEqual(['块.遮蔽-v2-jre-b.zip']);
    expect(screen.getByTestId('package-export-sha256').textContent).toBe('ef'.repeat(32));
    expect(screen.getByTestId('package-export-downloaded').textContent).toContain('Downloaded. SHA-256: ');
    expect(screen.queryByTestId('package-export-unsigned')).toBeNull();
    fireEvent.click(screen.getByTestId('package-export-copy'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('ef'.repeat(32)));
  });

  it('修订 4：包带显示排版时下载后显示「包含显示排版」；版本无排版（absent 或缺头）时不显示排版说明', async () => {
    fetchMock.mockResolvedValue(zip({ 'X-Aster-Package-Layout': 'included' }));
    renderPanel();
    exportJre();
    expect((await screen.findByTestId('package-export-layout-included')).textContent).toBe('Includes the display layout');
    expect(screen.queryByTestId('package-export-layout-omitted')).toBeNull();
    cleanup();

    for (const headers of [{ 'X-Aster-Package-Layout': 'absent' }, {}] as Record<string, string>[]) {
      fetchMock.mockResolvedValue(zip(headers));
      renderPanel();
      exportJre();
      await screen.findByTestId('package-export-downloaded');
      expect(screen.queryByTestId('package-export-layout-included')).toBeNull();
      expect(screen.queryByTestId('package-export-layout-omitted')).toBeNull();
      cleanup();
    }
  });

  it('修订 4：省略排版时按原因码显示本地化原因，未登记的原因用兜底文案', async () => {
    fetchMock.mockResolvedValue(zip({ 'X-Aster-Package-Layout': 'omitted', 'X-Aster-Package-Layout-Reason': 'node_display_check_failed' }));
    renderPanel();
    exportJre();
    const note = await screen.findByTestId('package-export-layout-omitted');
    expect(note.textContent).toBe('Layout left out: Node check failed');
    expect(note.getAttribute('data-reason')).toBe('node_display_check_failed');
    cleanup();

    fetchMock.mockResolvedValue(zip({ 'X-Aster-Package-Layout': 'omitted', 'X-Aster-Package-Layout-Reason': 'something_new' }));
    renderPanel();
    exportJre();
    const fallback = await screen.findByTestId('package-export-layout-omitted');
    expect(fallback.textContent).toBe('Layout left out');
    expect(fallback.getAttribute('data-reason')).toBe('other');
  });

  it('无签名包：显示「无签名包」提示', async () => {
    fetchMock.mockResolvedValue(zip({ 'X-Aster-Package-Signed': 'false' }));
    renderPanel();
    exportJre();
    expect((await screen.findByTestId('package-export-unsigned')).textContent).toBe('Not signed');
  });

  it('refused：列出诊断码、行列、本地化原因与英文原文；未登记码用兜底原因', async () => {
    fetchMock.mockResolvedValue(json(200, { exportable: false, diagnostics: [
      { severity: 'error', code: 'E734', message: 'Package size 2000000 bytes exceeds the 1048576-byte limit', startLine: 1, startColumn: 1, endLine: 1, endColumn: 1 },
      { severity: 'error', code: 'E999', message: 'Something new', startLine: 0, startColumn: 0, endLine: 0, endColumn: 0 },
    ] }));
    renderPanel();
    exportJre();
    const refused = await screen.findByTestId('package-export-refused');
    expect(refused.textContent).toContain("Can't be exported");
    expect(refused.textContent).toContain('E734');
    expect(refused.textContent).toContain('1:1');
    expect(refused.textContent).toContain('Too large');
    expect(refused.textContent).toContain('exceeds the 1048576-byte limit');
    expect(refused.textContent).toContain('Other reason');
    expect(refused.querySelector('[lang="en"]')).toBeTruthy();
    expect(downloads).toEqual([]);
  });

  it('entryRequired：先出现入口选择，选定后带 entry 导出', async () => {
    fetchMock.mockResolvedValue(zip());
    renderPanel(packages({ entryRequired: true, entryCandidates: ['decide', 'score'] }));
    exportJre();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Choose the entry'), { target: { value: 'score' } });
    fireEvent.click(screen.getByText('Export this entry'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ target: 'jre', uiLocale: 'en', entry: 'score' });
  });

  it('入口选择中切换 target：选择回到首个候选，提交的入口与 target 一致', async () => {
    fetchMock.mockResolvedValue(zip());
    renderPanel(packages({ node: 'exportable', entryRequired: true, entryCandidates: ['decide', 'score'] }));
    exportJre();
    fireEvent.change(screen.getByLabelText('Choose the entry'), { target: { value: 'score' } });
    fireEvent.click(screen.getByTestId('policy-export-menu-button'));
    fireEvent.click(screen.getByTestId('export-item-node'));
    expect((screen.getByLabelText('Choose the entry') as HTMLSelectElement).value).toBe('decide');
    fireEvent.click(screen.getByText('Export this entry'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ target: 'node', uiLocale: 'en', entry: 'decide' });
  });

  it('refused 的畸形诊断条目被丢弃，不影响渲染', async () => {
    fetchMock.mockResolvedValue(json(200, { exportable: false, diagnostics: [null, 'x', { code: 'E730', message: 'IO' }] }));
    renderPanel();
    exportJre();
    const refused = await screen.findByTestId('package-export-refused');
    expect(refused.querySelectorAll('li')).toHaveLength(1);
    expect(refused.textContent).toContain('Uses IO');
  });

  it('上游 400 entry_required：出现选择器（候选来自响应）', async () => {
    fetchMock.mockResolvedValue(json(400, { error: 'entry_required', code: 'entry_required', entryCandidates: ['a', 'b'] }));
    renderPanel();
    exportJre();
    const select = (await screen.findByLabelText('Choose the entry')) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual(['a', 'b']);
  });

  it.each([
    [409, { error: 'no executable version' }, 'Approve first'],
    [403, { error: 'policy_export_requires_plan', code: 'policy_export_requires_plan', upgrade: true }, 'Paid plan required'],
    [503, { error: 'package_export_busy', code: 'package_export_busy' }, 'Busy'],
    [429, { error: 'Rate limit exceeded' }, 'Busy'],
    [503, { error: 'export_signing_unavailable', code: 'export_signing_unavailable' }, 'Unavailable'],
    [503, { error: 'export_signing_kid_unanchored', code: 'export_signing_kid_unanchored' }, 'Unavailable'],
    [503, { error: 'export_runtime_skew', code: 'export_runtime_skew' }, 'Unavailable'],
    [502, { error: 'package_export_failed', code: 'package_export_failed', message: 'internal host:8080' }, 'Failed'],
  ])('%i %j → 本地化文案（role=alert，不显示服务端原文）', async (status, body, text) => {
    fetchMock.mockResolvedValue(json(status, body));
    renderPanel();
    exportJre();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(text);
  });

  it('网络异常 → Failed', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    renderPanel();
    exportJre();
    expect((await screen.findByRole('alert')).textContent).toBe('Failed');
  });
});
