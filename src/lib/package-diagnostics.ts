/**
 * 策略包导出诊断的边界收窄（ADR 0059 P2）：aster-api 的 check 与 export/package 响应里的 diagnostics
 * 原样进入页面渲染，畸形条目会让列表渲染失败或显示不全。纯函数、无服务端依赖，客户端与服务端共用。
 */
import type { PolicyDiagnostic } from '@/services/policy/policy-api';

/** 上游诊断在边界处收窄：只保留带字符串 message 的对象，行列缺失时记 0（面板不显示行列） */
export function safeDiagnostics(raw: unknown): PolicyDiagnostic[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is Record<string, unknown> => !!d && typeof d === 'object' && typeof (d as { message?: unknown }).message === 'string')
    .map((d) => ({
      severity: d.severity === 'warning' || d.severity === 'info' || d.severity === 'hint' ? d.severity : 'error',
      message: d.message as string,
      startLine: Number.isInteger(d.startLine) ? (d.startLine as number) : 0,
      startColumn: Number.isInteger(d.startColumn) ? (d.startColumn as number) : 0,
      endLine: Number.isInteger(d.endLine) ? (d.endLine as number) : 0,
      endColumn: Number.isInteger(d.endColumn) ? (d.endColumn as number) : 0,
      ...(typeof d.code === 'string' ? { code: d.code } : {}),
    }));
}

