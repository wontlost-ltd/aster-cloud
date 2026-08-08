import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { VersionComparePanel } from '@/components/policy/version-compare-panel';

/**
 * What-If 面板在版本比较里的**挂载条件**（ADR 0034 S4）。
 *
 * ★为什么单独测这个：挂载条件是
 * `leftRowId && rightRowId && leftVersion !== rightVersion`——
 * 三个条件各自有理由，但都容易在后续重构中被「顺手简化掉」：
 *
 *   · 缺 rowId 却仍挂载 → 会给批次 API 传 undefined，
 *     那正是上一版 `?? 0` 兜底的同类错误：用假值掩盖「输入不存在」
 *   · 同版本比较也挂载 → 「v3 换成 v3 会怎样」是个无意义的批次，
 *     白白吃掉租户唯一的并发额度（§7.2 pro 档只有 1 个）
 */

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  // 比较面板自身要拉两个版本的源码；这里只需让它不炸
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ content: 'Module m.\nRule r:\n  Return 1.' }),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const versions = [
  { id: 'row-3', version: 3, status: 'APPROVED' as const, isDefault: true, releaseNote: null, createdAt: '2026-08-01T00:00:00Z' },
  { id: 'row-2', version: 2, status: 'APPROVED' as const, isDefault: false, releaseNote: null, createdAt: '2026-07-01T00:00:00Z' },
];

describe('What-If 在版本比较里的挂载条件', () => {
  it('★两个不同版本且行 id 齐备 → 挂载', async () => {
    render(<VersionComparePanel policyId="p1" versions={versions} whatIfEntitled />);
    await waitFor(() =>
      expect(screen.getByText(/What-if impact analysis/i)).toBeTruthy(),
    );
  });

  it('★同一版本 → 不挂载（无意义的批次会白吃并发额度）', async () => {
    render(
      <VersionComparePanel
        policyId="p1"
        versions={versions}
        initialLeftVersion={3}
        initialRightVersion={3}
        whatIfEntitled
      />,
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/What-if impact analysis/i)).toBeNull();
  });

  it('★缺行 id → 不挂载，而不是传 undefined 给批次 API', async () => {
    // 模拟版本列表里没有对应行 id 的情况（如上游 map 漏传 id）
    const noId = versions.map(({ version, status, isDefault, releaseNote, createdAt }) => ({
      id: undefined as unknown as string,
      version,
      status,
      isDefault,
      releaseNote,
      createdAt,
    }));
    render(<VersionComparePanel policyId="p1" versions={noId} whatIfEntitled />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.queryByText(/What-if impact analysis/i)).toBeNull();
  });

  it('无权益时仍挂载，但呈现为禁用 + 升级引导（§7.5）', async () => {
    // 入口可见才有转化机会；服务端仍会硬拒 403
    render(<VersionComparePanel policyId="p1" versions={versions} whatIfEntitled={false} />);
    await waitFor(() =>
      expect(screen.getByText(/What-if impact analysis/i)).toBeTruthy(),
    );
    expect(screen.getByRole('button', { name: /run analysis/i })).toHaveProperty(
      'disabled',
      true,
    );
  });
});
