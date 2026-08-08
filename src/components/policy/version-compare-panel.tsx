'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { WhatIfBatchPanel } from './whatif-batch-panel';
import type { PolicyVersionStatus } from '@/lib/prisma';

interface VersionSummary {
  /** 版本行 id（不可变主键）。★What-If 批次按行 id 定位版本，不用 version 号——
   *  version 号可能重复或变动，行 id 唯一且不可变。 */
  id: string;
  version: number;
  status: PolicyVersionStatus;
  isDefault: boolean;
  releaseNote: string | null;
  createdAt: string;
}

interface VersionComparePanelProps {
  policyId: string;
  versions: VersionSummary[];
  initialLeftVersion?: number;
  initialRightVersion?: number;
  onClose?: () => void;
  /**
   * 租户是否拥有 What-If 权益（ADR 0034 §7.2）。
   * false → 面板入口可见但禁用 + 升级引导（§7.5）。
   * ★由 server component 读 plan 后传下来，不在客户端猜。
   */
  whatIfEntitled?: boolean;
}

interface DiffLine {
  type: 'unchanged' | 'added' | 'removed';
  content: string;
  leftLineNum?: number;
  rightLineNum?: number;
}

/**
 * 简单的文本差异算法
 */
function computeDiff(leftLines: string[], rightLines: string[]): DiffLine[] {
  const result: DiffLine[] = [];
  let leftIdx = 0;
  let rightIdx = 0;

  // 简单的 LCS 实现
  const lcs = computeLCS(leftLines, rightLines);

  for (const match of lcs) {
    // 处理左侧在 match 之前的行（删除）
    while (leftIdx < match.leftIdx) {
      result.push({
        type: 'removed',
        content: leftLines[leftIdx],
        leftLineNum: leftIdx + 1,
      });
      leftIdx++;
    }

    // 处理右侧在 match 之前的行（添加）
    while (rightIdx < match.rightIdx) {
      result.push({
        type: 'added',
        content: rightLines[rightIdx],
        rightLineNum: rightIdx + 1,
      });
      rightIdx++;
    }

    // 匹配的行
    result.push({
      type: 'unchanged',
      content: leftLines[leftIdx],
      leftLineNum: leftIdx + 1,
      rightLineNum: rightIdx + 1,
    });
    leftIdx++;
    rightIdx++;
  }

  // 处理剩余的行
  while (leftIdx < leftLines.length) {
    result.push({
      type: 'removed',
      content: leftLines[leftIdx],
      leftLineNum: leftIdx + 1,
    });
    leftIdx++;
  }

  while (rightIdx < rightLines.length) {
    result.push({
      type: 'added',
      content: rightLines[rightIdx],
      rightLineNum: rightIdx + 1,
    });
    rightIdx++;
  }

  return result;
}

interface LCSMatch {
  leftIdx: number;
  rightIdx: number;
}

function computeLCS(left: string[], right: string[]): LCSMatch[] {
  const m = left.length;
  const n = right.length;
  const dp: number[][] = Array(m + 1)
    .fill(null)
    .map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (left[i - 1] === right[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // 回溯获取 LCS
  const result: LCSMatch[] = [];
  let i = m;
  let j = n;

  while (i > 0 && j > 0) {
    if (left[i - 1] === right[j - 1]) {
      result.unshift({ leftIdx: i - 1, rightIdx: j - 1 });
      i--;
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

export function VersionComparePanel({
  policyId,
  versions,
  initialLeftVersion,
  initialRightVersion,
  onClose,
  whatIfEntitled = false,
}: VersionComparePanelProps) {
  const sortedVersions = useMemo(
    () => [...versions].sort((a, b) => b.version - a.version),
    [versions]
  );

  const [leftVersion, setLeftVersion] = useState<number>(
    initialLeftVersion ?? (sortedVersions[1]?.version || sortedVersions[0]?.version)
  );
  const [rightVersion, setRightVersion] = useState<number>(
    initialRightVersion ?? sortedVersions[0]?.version
  );

  // ★版本号 → 行 id：批次 API 按**行 id**定位版本（version 号可能重复/可变）。
  //   找不到时为 undefined → 面板不挂载，而不是传一个编造的 id。
  const leftRowId = useMemo(
    () => versions.find((v) => v.version === leftVersion)?.id,
    [versions, leftVersion],
  );
  const rightRowId = useMemo(
    () => versions.find((v) => v.version === rightVersion)?.id,
    [versions, rightVersion],
  );

  const [leftSource, setLeftSource] = useState<string | null>(null);
  const [rightSource, setRightSource] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchSource = useCallback(
    async (version: number): Promise<string | null> => {
      try {
        const response = await fetch(`/api/v1/policies/${policyId}/versions/${version}`);
        const data = await response.json();
        if (response.ok) {
          return data.source ?? data.content ?? '';
        }
        return null;
      } catch {
        return null;
      }
    },
    [policyId]
  );

  useEffect(() => {
    // 快速切换比较版本会并发多轮 loadSources：没有取消标志时，**先发后到**的
    // 那一轮会覆盖后发起的结果——界面标题写着「v1 vs v5」，左侧却是 v3 的源码，
    // 连带 diff 行数与增删统计全错，且无任何提示。审计发现（2026-07-29）。
    //
    // 这里用 cancelled 标志而非 AbortController：两个请求要成对写入状态，
    // 只要本轮已作废就整体丢弃，比逐个取消更贴合语义。
    let cancelled = false;

    async function loadSources() {
      setLoading(true);
      setError(null);

      try {
        const [left, right] = await Promise.all([
          fetchSource(leftVersion),
          fetchSource(rightVersion),
        ]);

        if (cancelled) return;

        if (left === null || right === null) {
          setError('无法加载版本源码');
        } else {
          setLeftSource(left);
          setRightSource(right);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '未知错误');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadSources();
    return () => {
      cancelled = true;
    };
  }, [leftVersion, rightVersion, fetchSource]);

  const diffLines = useMemo(() => {
    if (leftSource === null || rightSource === null) return [];
    return computeDiff(leftSource.split('\n'), rightSource.split('\n'));
  }, [leftSource, rightSource]);

  const stats = useMemo(() => {
    const added = diffLines.filter((l) => l.type === 'added').length;
    const removed = diffLines.filter((l) => l.type === 'removed').length;
    return { added, removed };
  }, [diffLines]);

  return (
    <div className="bg-bg dark:bg-gray-800 rounded-lg shadow-lg">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border dark:border-gray-700">
        <h2 className="text-xl font-semibold text-fg dark:text-white">
          版本对比
        </h2>
        {onClose && (
          <button
            onClick={onClose}
            className="text-fg-muted hover:text-fg dark:text-fg-subtle dark:hover:text-gray-200"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* Version Selectors */}
      <div className="flex items-center gap-4 px-6 py-4 border-b border-border dark:border-gray-700">
        <div className="flex-1">
          <label className="block text-sm font-medium text-fg-muted dark:text-fg-subtle mb-1">
            基准版本
          </label>
          <select
            value={leftVersion}
            onChange={(e) => setLeftVersion(parseInt(e.target.value, 10))}
            className="w-full px-3 py-2 border border-border-strong dark:border-gray-600 rounded-md text-sm bg-bg dark:bg-gray-900 text-fg dark:text-white"
          >
            {sortedVersions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} - {v.status} {v.isDefault ? '(默认)' : ''}
              </option>
            ))}
          </select>
        </div>

        <div className="text-fg-subtle self-end pb-2">
          <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
          </svg>
        </div>

        <div className="flex-1">
          <label className="block text-sm font-medium text-fg-muted dark:text-fg-subtle mb-1">
            比较版本
          </label>
          <select
            value={rightVersion}
            onChange={(e) => setRightVersion(parseInt(e.target.value, 10))}
            className="w-full px-3 py-2 border border-border-strong dark:border-gray-600 rounded-md text-sm bg-bg dark:bg-gray-900 text-fg dark:text-white"
          >
            {sortedVersions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version} - {v.status} {v.isDefault ? '(默认)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Stats */}
      <div className="flex items-center gap-4 px-6 py-2 text-sm border-b border-border dark:border-gray-700">
        <span className="text-green-600 dark:text-green-400">+{stats.added} 行添加</span>
        <span className="text-red-600 dark:text-red-400">-{stats.removed} 行删除</span>
      </div>

      {/* Diff View */}
      <div className="p-4 overflow-x-auto">
        {loading ? (
          <div className="animate-pulse space-y-2">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-6 bg-bg-muted dark:bg-gray-700 rounded" />
            ))}
          </div>
        ) : error ? (
          <div className="text-red-500 dark:text-red-400 text-center py-8">{error}</div>
        ) : (
          <div className="font-mono text-sm max-h-[500px] overflow-y-auto">
            {diffLines.map((line, idx) => (
              <div
                key={idx}
                className={`flex ${
                  line.type === 'added'
                    ? 'bg-green-50 dark:bg-green-900/30'
                    : line.type === 'removed'
                      ? 'bg-red-50 dark:bg-red-900/30'
                      : ''
                }`}
              >
                <span className="w-12 text-right px-2 text-fg-subtle dark:text-fg-muted select-none border-r border-border dark:border-gray-700">
                  {line.leftLineNum ?? ''}
                </span>
                <span className="w-12 text-right px-2 text-fg-subtle dark:text-fg-muted select-none border-r border-border dark:border-gray-700">
                  {line.rightLineNum ?? ''}
                </span>
                <span
                  className={`w-6 text-center select-none ${
                    line.type === 'added'
                      ? 'text-green-600 dark:text-green-400'
                      : line.type === 'removed'
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-300 dark:text-fg-muted'
                  }`}
                >
                  {line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
                </span>
                <span className="flex-1 px-2 text-fg dark:text-gray-100 whitespace-pre">
                  {line.content || ' '}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/*
        What-If 影响估算（ADR 0034）。挂在版本比较里而不是 analytics 区，
        理由是**输入天然在这里**：leftVersion/rightVersion 就是要比较的两个版本。
        上面的 diff 回答「源码改了什么」，这里回答「决策会怎么变」——
        同一个问题的两面，放在一起用户不必跨区拼凑上下文。
      */}
      {leftRowId && rightRowId && leftVersion !== rightVersion && (
        <div className="mt-4">
          <WhatIfBatchPanel
            policyId={policyId}
            baseVersionId={leftRowId}
            targetVersionId={rightRowId}
            entitled={whatIfEntitled}
          />
        </div>
      )}
    </div>
  );
}
