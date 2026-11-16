/**
 * 策略能否导出为 Cedar（#786）：详情页只在可导出时显示「导出为 Cedar」。
 *
 * 判定来自 aster-api 的轻量检查端点 `POST /api/v1/policies/export/cedar/check`：与导出同一编译输入，
 * 只编译并翻译（规则形状 E720、可翻译子集 E721、context 键类型 E722），不跑等价性探针、不占导出并发、
 * 不写审计。E723 / E724 是编译器缺陷信号，只有真正导出时才会出现，导出面板照常展示诊断。
 *
 * 成本控制：详情页每次渲染都会问一次，故
 * - 按编译输入（源码、语言、别名集、词汇、结构词授权）的 SHA-256 缓存确定结果（进程内，有上限与 TTL），
 *   同一输入的并发请求共用一次调用；已批准版本不可变，命中率高；
 * - 单独的短超时，超时 / 上游错误 / 旧版 aster-api 尚无该端点（404）一律返回 'unknown' 且不缓存。
 *   'unknown' 时页面照旧显示按钮（导出本身会说明原因），不因一次瞬时故障把可用的功能藏起来。
 */
import { createHash } from 'node:crypto';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { policyTenantId } from '@/lib/policy-tenant';
import { loadCedarExportInput, type CedarExportVersion } from '@/lib/cedar-export-input';

export type CedarExportability = 'exportable' | 'not-exportable' | 'unknown';

/** 检查请求的超时：详情页渲染在等它，宁可判「未知」也不拖住整页 */
export const CEDAR_CHECK_TIMEOUT_MS = 2_000;
/** 缓存条目上限（超出时淘汰最早写入的） */
const MAX_ENTRIES = 500;
/** 确定结果的有效期：aster-api 升级后编译器可能放宽 / 收紧可翻译子集，不永久缓存 */
const TTL_MS = 60 * 60 * 1000;

const cache = new Map<string, { exportable: boolean; expiresAt: number }>();
const inflight = new Map<string, Promise<CedarExportability>>();

/** 仅供测试：清空缓存 */
export function clearCedarExportabilityCache(): void {
  cache.clear();
  inflight.clear();
}

function cached(key: string, now: number): CedarExportability | null {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt > now) return hit.exportable ? 'exportable' : 'not-exportable';
  cache.delete(key);
  return null;
}

function remember(key: string, exportable: boolean, now: number): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { exportable, expiresAt: now + TTL_MS });
}

interface CheckArgs {
  policy: { id: string; userId: string; teamId: string | null };
  /** 导出会选中的版本（无可执行版本时为最新版本，用于「批准后可导出」的提示） */
  version: CedarExportVersion;
  userId: string;
}

export async function checkCedarExportability({ policy, version, userId }: CheckArgs): Promise<CedarExportability> {
  let request;
  try {
    ({ request } = await loadCedarExportInput(version, policy.teamId ?? null));
  } catch (error) {
    console.warn('[cedar-exportability] compile input unavailable', policy.id, error);
    return 'unknown';
  }
  const key = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const hit = cached(key, Date.now());
  if (hit) return hit;
  const pending = inflight.get(key);
  if (pending) return pending;

  const run = (async (): Promise<CedarExportability> => {
    try {
      const client = await createPolicyApiClientForUser(policyTenantId(policy), userId);
      const res = await client.checkCedarExport(request, CEDAR_CHECK_TIMEOUT_MS);
      if (typeof res?.exportable !== 'boolean') return 'unknown';
      remember(key, res.exportable, Date.now());
      return res.exportable ? 'exportable' : 'not-exportable';
    } catch (error) {
      console.warn('[cedar-exportability] check failed', policy.id, error instanceof Error ? error.message : error);
      return 'unknown';
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, run);
  return run;
}
