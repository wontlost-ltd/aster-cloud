/**
 * 策略包是否携带显示排版（ADR 0059 修订 4 D11）：响应头 `X-Aster-Package-Layout` 与 `X-Aster-Package-Layout-Reason` 的
 * 取值与解析。纯函数、无服务端依赖：policy-api 客户端、导出路由与浏览器端导出面板共用。
 */

export const PACKAGE_LAYOUT_HEADER = 'X-Aster-Package-Layout';
export const PACKAGE_LAYOUT_REASON_HEADER = 'X-Aster-Package-Layout-Reason';

export const PACKAGE_LAYOUT_STATUSES = ['included', 'absent', 'omitted'] as const;
export type PackageLayoutStatus = (typeof PACKAGE_LAYOUT_STATUSES)[number];

/** cloud 侧省略的原因（不发送排版）。 */
export const CLOUD_LAYOUT_REASONS = ['layout_inconsistent', 'layout_invalid', 'layout_export_disabled', 'node_display_check_failed'] as const;
export type CloudLayoutReason = (typeof CLOUD_LAYOUT_REASONS)[number];

/** 全部省略原因：cloud 侧四个 + aster-api 签名前闸门两个。 */
export const PACKAGE_LAYOUT_REASONS = [...CLOUD_LAYOUT_REASONS, 'display_rules_failed', 'cli_unsupported'] as const;
export type PackageLayoutReason = (typeof PACKAGE_LAYOUT_REASONS)[number];

export interface PackageLayoutOutcome {
  status: PackageLayoutStatus;
  /** 只在 omitted 时非 null；未登记的原因码记为 null（面板显示兜底文案） */
  reason: PackageLayoutReason | null;
}

/**
 * 读响应头。头缺失或取值不明时按 absent（修订 4 之前的 aster-api 不写这两个头，它产出的包也确实不带排版）；
 * omitted 的原因只认登记过的码。
 */
export function readPackageLayout(headers: Pick<Headers, 'get'>): PackageLayoutOutcome {
  const raw = headers.get(PACKAGE_LAYOUT_HEADER)?.trim().toLowerCase();
  const status = (PACKAGE_LAYOUT_STATUSES as readonly string[]).includes(raw ?? '') ? (raw as PackageLayoutStatus) : 'absent';
  if (status !== 'omitted') return { status, reason: null };
  const reason = headers.get(PACKAGE_LAYOUT_REASON_HEADER)?.trim();
  return {
    status,
    reason: (PACKAGE_LAYOUT_REASONS as readonly string[]).includes(reason ?? '') ? (reason as PackageLayoutReason) : null,
  };
}
