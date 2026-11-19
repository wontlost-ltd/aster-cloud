/**
 * 策略包能否导出（ADR 0059 P2，T17）：详情页据此决定「导出」菜单里显示哪些包选项。
 *
 * 判定来自 aster-api `POST /api/v1/policies/export/package/check`（修订 3 P2-R8）：编译 + 静态检查，
 * 按 target 分别给结论，不跑探针、不占导出并发、不写审计。成本控制照 cedar-exportability：
 * - 按请求体（编译输入 + claimedRef）的 SHA-256 缓存确定结果（进程内，有上限与 TTL），同一输入的并发请求共用一次调用；
 *   claimedRef 含 cloud 策略 id，缓存键因此天然按策略（即按租户）区分，check 结论也只由请求体决定；
 * - 2 s 超时；超时 / 上游错误 / 旧版 aster-api 无该端点（404）/ 响应形状不对，一律 'unknown' 且不缓存。
 *
 * node 在两种情况下为 'unavailable'：check 给出 unavailable 码（如锁文件 node 为 null），
 * 或 cloud 本地不能复核 Node 包（package-node-runtime 返回 null）。check 响应不带锁文件版本，
 * 本地 ts 版本（TS_VERSION）与锁文件 node.cliVersion 的比较在下载路由 prepare 之后进行（不等即 503 export_runtime_skew）。
 */
import { createHash } from 'node:crypto';
import { createPolicyApiClientForUser } from '@/lib/policy-api-identity';
import { policyTenantId } from '@/lib/policy-tenant';
import { loadPackageExportInput, type PackageExportVersion } from '@/lib/package-export-input';
import { nodePackageRuntime } from '@/lib/package-node-runtime';
import { safeDiagnostics } from '@/lib/package-diagnostics';
import type {
  PackageExportCheckResponse,
  PackageExportTarget,
  PackageExportTargetCheck,
  PolicyDiagnostic,
} from '@/services/policy/policy-api';

export type PackageTargetState = 'exportable' | 'not-exportable' | 'unavailable' | 'unknown';

export interface PackageExportability {
  jre: PackageTargetState;
  node: PackageTargetState;
  /** 各 target 的检查诊断（not-exportable 时说明原因，菜单「查看原因」直接展示，不再请求） */
  diagnostics: Record<PackageExportTarget, PolicyDiagnostic[]>;
  /** 确定不了唯一入口时为 null，此时导出前须让用户在 entryCandidates 中选择 */
  defaultEntry: string | null;
  entryCandidates: string[];
}

/** 检查请求的超时：详情页渲染在等它，宁可判「未知」也不拖住整页 */
export const PACKAGE_CHECK_TIMEOUT_MS = 2_000;
const MAX_ENTRIES = 500;
/** aster-api 升级后检查可能放宽 / 收紧，不永久缓存 */
const TTL_MS = 60 * 60 * 1000;

/** 检查拿不到结论时：jre 未知（照常显示）；node 仍受本地复核能力约束 */
function unknownResult(): PackageExportability {
  return {
    jre: 'unknown',
    node: nodePackageRuntime() ? 'unknown' : 'unavailable',
    diagnostics: { jre: [], node: [] },
    defaultEntry: null,
    entryCandidates: [],
  };
}

const cache = new Map<string, { value: PackageExportCheckResponse; expiresAt: number }>();
const inflight = new Map<string, Promise<PackageExportCheckResponse | null>>();

/** 仅供测试：清空缓存 */
export function clearPackageExportabilityCache(): void {
  cache.clear();
  inflight.clear();
}

function remember(key: string, value: PackageExportCheckResponse, now: number): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: now + TTL_MS });
}

function isTargetCheck(v: unknown): v is PackageExportTargetCheck {
  return !!v && typeof v === 'object' && typeof (v as PackageExportTargetCheck).exportable === 'boolean';
}

/** 响应形状是否可用：至少有 jre 一项结论（node 缺省视为不提供） */
function isCheckResponse(v: unknown): v is PackageExportCheckResponse {
  const targets = (v as PackageExportCheckResponse | null)?.targets;
  return !!targets && typeof targets === 'object' && isTargetCheck(targets.jre);
}

function targetState(check: PackageExportTargetCheck | undefined): PackageTargetState {
  if (!isTargetCheck(check) || check.unavailable) return 'unavailable';
  return check.exportable ? 'exportable' : 'not-exportable';
}

function toExportability(res: PackageExportCheckResponse): PackageExportability {
  const node = nodePackageRuntime() ? targetState(res.targets.node) : 'unavailable';
  return {
    jre: targetState(res.targets.jre),
    node,
    diagnostics: {
      jre: safeDiagnostics(res.targets.jre?.diagnostics),
      node: node === 'not-exportable' ? safeDiagnostics(res.targets.node?.diagnostics) : [],
    },
    defaultEntry: typeof res.defaultEntry === 'string' ? res.defaultEntry : null,
    entryCandidates: Array.isArray(res.entryCandidates) ? res.entryCandidates.filter((e) => typeof e === 'string') : [],
  };
}

interface CheckArgs {
  policy: { id: string; userId: string; teamId: string | null };
  /** 导出会选中的版本（findDefaultExecutableVersion 的结果，必为已批准版本） */
  version: PackageExportVersion;
  userId: string;
}

export async function checkPackageExportability({ policy, version, userId }: CheckArgs): Promise<PackageExportability> {
  let input;
  try {
    input = await loadPackageExportInput(policy, version);
  } catch (error) {
    console.warn('[package-exportability] compile input unavailable', policy.id, error);
    return unknownResult();
  }
  // check 对 target 无关（按 target 分别给结论），按 aster-api 的入参校验带上 jre
  const request = { ...input.request, target: 'jre' as const, uiLocale: 'en' as const };
  const key = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return toExportability(hit.value);
  if (hit) cache.delete(key);

  let pending = inflight.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const client = await createPolicyApiClientForUser(policyTenantId(policy), userId);
        const res = await client.checkPackageExport(request, PACKAGE_CHECK_TIMEOUT_MS);
        if (!isCheckResponse(res)) return null;
        remember(key, res, Date.now());
        return res;
      } catch (error) {
        console.warn('[package-exportability] check failed', policy.id, error instanceof Error ? error.message : error);
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, pending);
  }
  const res = await pending;
  return res ? toExportability(res) : unknownResult();
}
