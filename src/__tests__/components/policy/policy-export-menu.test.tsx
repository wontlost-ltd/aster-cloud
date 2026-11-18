import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * 详情页「导出」菜单（ADR 0059 P2，T19）：显示 / 禁用 / 隐藏矩阵、键盘与焦点、选中后的请求。
 * - packages 为 null 或两个 target 都 unavailable：只有 Cedar 时保持原单按钮，Cedar 也没有时不渲染；
 * - exportable / unknown 可选；not-exportable 为 aria-disabled，选中即查看原因；unavailable 不显示。
 */

import { PolicyExportMenu } from '@/components/policy/policy-export-menu';
import { CedarExportProvider, type CedarExportLabels } from '@/components/policy/cedar-export-panel';
import { PackageExportProvider, PackageExportStatus } from '@/components/policy/package-export-panel';
import { packageExportLabels as labels } from '@/__tests__/helpers/package-export-labels';
import type { PackageExportMenuState } from '@/lib/package-export-state';

const cedarLabels = {
  button: 'Export to Cedar', exporting: 'Exporting…', verified: '{count}', notExportable: 'x', failed: 'x', busy: 'x',
  noExecutableVersion: 'Approve a version first', versionsLink: 'Versions', schemaNote: 'x', chooseRule: 'x', exportRule: 'x',
} satisfies CedarExportLabels;

const diag = { severity: 'error' as const, code: 'E730', message: "Function 'f' declares IO capability Http", startLine: 3, startColumn: 5, endLine: 3, endColumn: 5 };
const state = (over: Partial<PackageExportMenuState> = {}): PackageExportMenuState => ({
  jre: 'exportable', node: 'unavailable', diagnostics: { jre: [], node: [] }, entryRequired: false, entryCandidates: [], ...over,
});

function renderMenu({ showCedar = true, packages = state() as PackageExportMenuState | null, hasExecutableVersion = true } = {}) {
  const menu = <PolicyExportMenu showCedar={showCedar} packages={packages} labels={labels} />;
  const withPackages = packages ? (
    <PackageExportProvider policyId="p1" locale="de" labels={labels} packages={packages}>{menu}<PackageExportStatus /></PackageExportProvider>
  ) : menu;
  return render(showCedar ? (
    <CedarExportProvider policyId="p1" labels={cedarLabels} hasExecutableVersion={hasExecutableVersion} versionsHref="/en/policies/p1/versions">
      {withPackages}
    </CedarExportProvider>
  ) : withPackages);
}

const open = () => fireEvent.click(screen.getByTestId('policy-export-menu-button'));
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ exportable: false, diagnostics: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PolicyExportMenu', () => {
  it('packages null + Cedar：原来的「导出为 Cedar」单按钮', () => {
    renderMenu({ packages: null });
    expect(screen.getByTestId('cedar-export-button')).toBeTruthy();
    expect(screen.queryByTestId('policy-export-menu-button')).toBeNull();
  });

  it('两个 target 都 unavailable：同样回到单按钮', () => {
    renderMenu({ packages: state({ jre: 'unavailable' }) });
    expect(screen.getByTestId('cedar-export-button')).toBeTruthy();
  });

  it('packages null 且无 Cedar：什么都不渲染', () => {
    const { container } = renderMenu({ showCedar: false, packages: null });
    expect(container.innerHTML).toBe('');
  });

  it('有包选项：下拉依次为 Cedar、JRE；Node unavailable 不显示；每项一行说明', () => {
    renderMenu();
    const trigger = screen.getByTestId('policy-export-menu-button');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    open();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const items = Array.from(document.querySelectorAll('[data-dropdown-panel] button'));
    expect(items.map((b) => b.getAttribute('data-testid'))).toEqual(['export-item-cedar', 'export-item-jre']);
    expect(screen.getByTestId('export-item-jre').textContent).toContain('Needs Java 25');
    expect(screen.getByTestId('export-item-cedar').textContent).toContain('For a gateway');
  });

  it('Cedar 不可见时下拉里只有包项', () => {
    renderMenu({ showCedar: false, packages: state({ node: 'exportable' }) });
    open();
    expect(screen.queryByTestId('export-item-cedar')).toBeNull();
    expect(screen.getByTestId('export-item-jre')).toBeTruthy();
    expect(screen.getByTestId('export-item-node')).toBeTruthy();
  });

  it('unknown 照常显示且可选', () => {
    renderMenu({ packages: state({ jre: 'unknown' }) });
    open();
    const item = screen.getByTestId('export-item-jre');
    expect(item.hasAttribute('disabled')).toBe(false);
    expect(item.getAttribute('aria-disabled')).toBeNull();
  });

  it('not-exportable：aria-disabled，说明指向原因；选中后状态区列出诊断而不请求导出', () => {
    renderMenu({ packages: state({ jre: 'not-exportable', diagnostics: { jre: [diag], node: [] } }) });
    open();
    const item = screen.getByTestId('export-item-jre');
    expect(item.getAttribute('aria-disabled')).toBe('true');
    const hint = document.getElementById(item.getAttribute('aria-describedby')!);
    expect(hint?.textContent).toBe("Can't be exported · Show reasons");
    fireEvent.click(item);
    expect(fetchMock).not.toHaveBeenCalled();
    const refused = screen.getByTestId('package-export-refused');
    expect(refused.getAttribute('role')).toBe('alert');
    expect(refused.textContent).toContain('E730');
    expect(refused.textContent).toContain('3:5');
    expect(refused.textContent).toContain('Uses IO');
  });

  it('无已批准版本：Cedar 项禁用并以 aria-describedby 指向「先批准」提示', () => {
    renderMenu({ hasExecutableVersion: false });
    open();
    const cedar = screen.getByTestId('export-item-cedar');
    expect(cedar.hasAttribute('disabled')).toBe(true);
    expect(cedar.getAttribute('aria-describedby')).toBe('cedar-export-no-version');
  });

  it('选 JRE：POST 包路由，请求体带 target 与界面语言', async () => {
    renderMenu();
    open();
    fireEvent.click(screen.getByTestId('export-item-jre'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/policies/p1/export/package');
    expect(JSON.parse(init.body as string)).toEqual({ target: 'jre', uiLocale: 'de' });
  });

  it('选 Cedar：走原 Cedar 导出路由', async () => {
    renderMenu();
    open();
    fireEvent.click(screen.getByTestId('export-item-cedar'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/policies/p1/export/cedar');
  });

  it('键盘：Esc 关闭并把焦点还给触发按钮；选中后同样回焦', () => {
    renderMenu();
    const trigger = screen.getByTestId('policy-export-menu-button');
    trigger.focus();
    open();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('[data-dropdown-panel]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    open();
    fireEvent.click(screen.getByTestId('export-item-jre'));
    expect(document.activeElement).toBe(trigger);
  });

  it('可访问名即可见文字（「导出中…」占位 aria-hidden）', () => {
    renderMenu();
    const trigger = screen.getByTestId('policy-export-menu-button');
    expect(trigger.getAttribute('aria-label')).toBeNull();
    expect(trigger.querySelector('[aria-hidden="true"]')?.textContent).toBe('Exporting…');
  });

  it('导出中：触发按钮 aria-busy，文案叠放（宽度不变）', async () => {
    let resolve!: (r: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((r) => { resolve = r; }));
    renderMenu();
    open();
    fireEvent.click(screen.getByTestId('export-item-jre'));
    const trigger = screen.getByTestId('policy-export-menu-button');
    await waitFor(() => expect(trigger.getAttribute('aria-busy')).toBe('true'));
    expect(trigger.querySelector('.invisible')?.textContent).toBe('Export');
    resolve(new Response(JSON.stringify({ exportable: false, diagnostics: [] }), { status: 200 }));
    await waitFor(() => expect(trigger.getAttribute('aria-busy')).toBeNull());
  });
});
