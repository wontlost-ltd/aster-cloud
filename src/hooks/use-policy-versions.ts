'use client';

import { useState, useCallback, useEffect } from 'react';
import type { PolicyVersionStatus } from '@/lib/prisma';
import { extractErrorMessage } from '@/lib/api/error-envelope';

/**
 * 版本信息
 */
interface PolicyVersionInfo {
  id: string;
  version: number;
  sourceHash: string | null;
  status: PolicyVersionStatus;
  isDefault: boolean;
  releaseNote: string | null;
  createdBy: string;
  createdAt: string;
  deprecatedAt: string | null;
  deprecatedBy: string | null;
  archivedAt: string | null;
  archivedBy: string | null;
  _count?: { approvals: number };
}

/**
 * 可执行版本信息（简化版）
 */
interface ExecutableVersionInfo {
  version: number;
  sourceHash: string | null;
  status: PolicyVersionStatus;
  isDefault: boolean;
  releaseNote: string | null;
  deprecatedAt: string | null;
}

/**
 * Hook 选项
 */
interface UsePolicyVersionsOptions {
  /** 策略 ID */
  policyId: string;
  /** 是否只加载可执行版本 */
  executableOnly?: boolean;
  /** 是否自动加载 */
  autoLoad?: boolean;
}

/**
 * Approve 失败时的结构化错误码
 * - invite_reviewer_required：单 seat 用户需先邀请 reviewer
 * - segregation_of_duties：多 seat 自审 SOX 违规
 * - vocabulary_changed_since_save：保存后作者词汇已变，需保存新版本再提交
 */
export type ApproveErrorCode =
  | 'invite_reviewer_required'
  | 'segregation_of_duties'
  | 'vocabulary_changed_since_save'
  | 'other';

export interface ApproveResult {
  ok: boolean;
  errorCode?: ApproveErrorCode;
  message?: string;
  cta?: { label: string; href: string };
}

/**
 * Hook 返回类型
 */
interface UsePolicyVersionsResult {
  /** 版本列表 */
  versions: PolicyVersionInfo[] | ExecutableVersionInfo[];
  /** 是否正在加载 */
  loading: boolean;
  /** 列表加载失败的错误信息（只表示版本列表没加载出来）。 */
  error: string | null;
  /**
   * 最近一次版本操作（创建 / 设默认 / 废弃 / 归档 / 提交 / 驳回）失败的信息。
   * 与 error 分开：操作失败时版本列表仍有效，界面应在列表上方提示而不是替换列表。
   * 批准失败返回结构化 ApproveResult 由调用方提示，不写这里。
   */
  actionError: string | null;
  /** 清除 actionError（用户关闭提示）。 */
  clearActionError: () => void;
  /** 刷新版本列表 */
  refresh: () => Promise<void>;
  /** 创建新版本 */
  createVersion: (source: string, releaseNote?: string) => Promise<{
    id: string;
    version: number;
    sourceHash: string;
  } | null>;
  /** 设置默认版本 */
  setDefault: (version: number) => Promise<boolean>;
  /** 废弃版本 */
  deprecate: (version: number, reason?: string) => Promise<boolean>;
  /** 归档版本 */
  archive: (version: number, reason?: string) => Promise<boolean>;
  /** 提交审批 */
  submitForApproval: (version: number, releaseNote?: string) => Promise<boolean>;
  /** 批准版本（返回结构化结果，便于 UI 区分 SOX 错误） */
  approve: (version: number, comment?: string) => Promise<ApproveResult>;
  /** 拒绝版本 */
  reject: (version: number, comment: string) => Promise<boolean>;
}

/**
 * 策略版本管理 Hook
 *
 * 提供版本的 CRUD 和状态管理功能：
 * - 获取版本列表
 * - 创建新版本
 * - 设置默认版本
 * - 废弃版本
 * - 归档版本
 */
export function usePolicyVersions({
  policyId,
  executableOnly = false,
  autoLoad = true,
}: UsePolicyVersionsOptions): UsePolicyVersionsResult {
  const [versions, setVersions] = useState<
    PolicyVersionInfo[] | ExecutableVersionInfo[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const clearActionError = useCallback(() => setActionError(null), []);

  // 加载版本列表
  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const url = executableOnly
        ? `/api/v1/policies/${policyId}/versions?executable=true`
        : `/api/v1/policies/${policyId}/versions`;

      const response = await fetch(url);
      const data = await response.json();

      if (response.ok) {
        setVersions(data.versions || []);
      } else {
        setError(extractErrorMessage(data) || '获取版本列表失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [policyId, executableOnly]);

  // 自动加载
  useEffect(() => {
    if (autoLoad && policyId) {
      // 挂载/依赖变化时异步拉取版本列表；setState 均在 await 之后触发，
      // 属正常数据加载副作用，非渲染期同步 setState。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      refresh();
    }
  }, [autoLoad, policyId, refresh]);

  // 创建新版本
  const createVersion = useCallback(
    async (
      source: string,
      releaseNote?: string
    ): Promise<{ id: string; version: number; sourceHash: string } | null> => {
      setActionError(null);

      try {
        const response = await fetch(`/api/v1/policies/${policyId}/versions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, releaseNote }),
        });

        const data = await response.json();

        if (response.ok) {
          await refresh();
          return data;
        } else {
          setActionError(extractErrorMessage(data) || '创建版本失败');
          return null;
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '未知错误');
        return null;
      }
    },
    [policyId, refresh]
  );

  // 设置默认版本
  const setDefault = useCallback(
    async (version: number): Promise<boolean> => {
      setActionError(null);

      try {
        const response = await fetch(
          `/api/v1/policies/${policyId}/versions/${version}/set-default`,
          { method: 'POST' }
        );

        const data = await response.json();

        if (response.ok) {
          await refresh();
          return true;
        } else {
          setActionError(extractErrorMessage(data) || '设置默认版本失败');
          return false;
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '未知错误');
        return false;
      }
    },
    [policyId, refresh]
  );

  // 废弃版本
  const deprecate = useCallback(
    async (version: number, reason?: string): Promise<boolean> => {
      setActionError(null);

      try {
        const response = await fetch(
          `/api/v1/policies/${policyId}/versions/${version}/deprecate`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
          }
        );

        const data = await response.json();

        if (response.ok) {
          await refresh();
          return true;
        } else {
          setActionError(extractErrorMessage(data) || '废弃版本失败');
          return false;
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '未知错误');
        return false;
      }
    },
    [policyId, refresh]
  );

  // 归档版本
  const archive = useCallback(
    async (version: number, reason?: string): Promise<boolean> => {
      setActionError(null);

      try {
        const response = await fetch(
          `/api/v1/policies/${policyId}/versions/${version}/archive`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason }),
          }
        );

        const data = await response.json();

        if (response.ok) {
          await refresh();
          return true;
        } else {
          setActionError(extractErrorMessage(data) || '归档版本失败');
          return false;
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '未知错误');
        return false;
      }
    },
    [policyId, refresh]
  );

  // 提交审批
  const submitForApproval = useCallback(
    async (version: number, releaseNote?: string): Promise<boolean> => {
      setActionError(null);

      try {
        const response = await fetch(
          `/api/v1/policies/${policyId}/versions/${version}/submit`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ releaseNote }),
          }
        );

        const data = await response.json();

        if (response.ok) {
          await refresh();
          return true;
        } else {
          setActionError(extractErrorMessage(data) || '提交审批失败');
          return false;
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '未知错误');
        return false;
      }
    },
    [policyId, refresh]
  );

  // 批准版本：失败只返回结构化结果，由调用方按错误码提示，不写 actionError（避免重复提示）。
  const approve = useCallback(
    async (version: number, comment?: string): Promise<ApproveResult> => {
      // 新操作开始即清掉上一次操作的失败提示（成功后横幅不残留）
      setActionError(null);
      try {
        const response = await fetch(
          `/api/v1/policies/${policyId}/versions/${version}/approve`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comment }),
          }
        );

        const data = await response.json();

        if (response.ok) {
          await refresh();
          return { ok: true };
        }

        const code = (data?.error ?? '') as string;
        const errorCode: ApproveErrorCode =
          code === 'invite_reviewer_required' ||
          code === 'segregation_of_duties' ||
          code === 'vocabulary_changed_since_save'
            ? code
            : 'other';
        return { ok: false, errorCode, message: data?.message, cta: data?.cta };
      } catch (err) {
        const message = err instanceof Error ? err.message : '未知错误';
        return { ok: false, errorCode: 'other', message };
      }
    },
    [policyId, refresh]
  );

  // 拒绝版本
  const reject = useCallback(
    async (version: number, comment: string): Promise<boolean> => {
      setActionError(null);

      try {
        const response = await fetch(
          `/api/v1/policies/${policyId}/versions/${version}/reject`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ comment }),
          }
        );

        const data = await response.json();

        if (response.ok) {
          await refresh();
          return true;
        } else {
          setActionError(extractErrorMessage(data) || '拒绝失败');
          return false;
        }
      } catch (err) {
        setActionError(err instanceof Error ? err.message : '未知错误');
        return false;
      }
    },
    [policyId, refresh]
  );

  return {
    versions,
    loading,
    error,
    actionError,
    clearActionError,
    refresh,
    createVersion,
    setDefault,
    deprecate,
    archive,
    submitForApproval,
    approve,
    reject,
  };
}

/**
 * 获取默认版本信息的简化 Hook
 */
export function useDefaultVersion(policyId: string) {
  const [defaultVersion, setDefaultVersion] = useState<ExecutableVersionInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!policyId) return;

    setLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `/api/v1/policies/${policyId}/versions?executable=true`
      );
      const data = await response.json();

      if (response.ok) {
        const versions = data.versions as ExecutableVersionInfo[];
        // 找到默认版本或第一个版本
        const defaultVer =
          versions.find((v) => v.isDefault) || versions[0] || null;
        setDefaultVersion(defaultVer);
      } else {
        setError(extractErrorMessage(data) || '获取版本失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '未知错误');
    } finally {
      setLoading(false);
    }
  }, [policyId]);

  useEffect(() => {
    // 挂载/依赖变化时异步拉取默认版本；setState 均在 await 之后触发，
    // 属正常数据加载副作用，非渲染期同步 setState。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    refresh();
  }, [refresh]);

  return { defaultVersion, loading, error, refresh };
}

export type {
  PolicyVersionInfo,
  ExecutableVersionInfo,
  UsePolicyVersionsOptions,
  UsePolicyVersionsResult,
};
