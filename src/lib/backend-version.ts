import 'server-only';

import { signInternalCallerHeaders } from './api-signing';

/**
 * 取后端 aster-api 的引擎版本（供「关于」弹框展示）。
 *
 * <p><b>为什么在服务端取</b>：{@code GET /api/v1/version} 是 {@code @RequireRole(VIEWER)}
 * 的**已鉴权**端点，需要 HMAC 签名 + X-Tenant-Id + X-User-Role。做成公开端点要同时改
 * RequestSignatureFilter 与 TenantFilter 两处 perimeter，为一个展示弹框改安全边界不划算
 * （见 aster-api VersionResource 的注释）。故由 BFF 在服务端带齐凭证取，再把结果传给
 * 客户端组件。
 *
 * <p><b>失败即 null，绝不抛</b>：版本展示是纯信息性的，后端抖动/未部署新版/密钥未配
 * 都不该让整个 dashboard 布局渲染失败。调用方拿到 null 时显示「不可用」。
 */

const ASTER_API_BASE =
  process.env.ASTER_POLICY_API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL ||
  'https://policy.aster-lang.dev';

const VERSION_PATH = '/api/v1/version';

/** 后端版本响应（与 aster-api VersionResource.VersionInfo 对齐）。 */
interface VersionInfo {
  engine?: string;
  toolchain?: string;
}

/**
 * @param tenantId 调用方租户（TenantFilter 要求非豁免路径必须带）
 * @returns 后端引擎版本；任何失败都返回 null
 */
export async function fetchBackendVersion(tenantId: string): Promise<string | null> {
  try {
    const role = 'VIEWER';
    // ★签名参数必须与实际发送的 header 逐字一致（body/tenant/role 都进签名）。
    const signed = await signInternalCallerHeaders('GET', VERSION_PATH, '', tenantId, role, {
      query: '',
      userId: '',
    });

    const res = await fetch(`${ASTER_API_BASE}${VERSION_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Tenant-Id': tenantId,
        'X-User-Role': role,
        ...signed,
      },
      // 版本几乎不变，缓存 5 分钟——避免每次渲染 dashboard 都打后端一次。
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;

    const info = (await res.json()) as VersionInfo;
    const engine = info.engine?.trim();
    return engine ? engine : null;
  } catch {
    // 密钥未配 / 网络失败 / JSON 畸形 —— 一律降级为「不可用」，不影响布局渲染。
    return null;
  }
}
