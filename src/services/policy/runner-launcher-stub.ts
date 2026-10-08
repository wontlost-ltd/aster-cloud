// ★这是 stub/契约参考实现：真验独立 HMAC key，返回固定 ReplayMetadata（Slice-2a 验接线）。
//   Slice-2b 真 launcher 复用同一 HMAC 验证契约，但用真 runner Job 产 ReplayMetadata。
// buildInternalCanonicalV3/hmacVerify 已在 api-signing.ts 导出（DRY），保证 stub 验的 canonical
// 与 client（signRunnerLauncherHeaders）签的逐字节一致；hmacVerify 用 crypto.subtle.verify
// 常数时间原语（非手写 hex 比对）。
import { buildInternalCanonicalV3, hmacVerify } from '../../lib/api-signing';

let stubReplayMetadata: Record<string, unknown> = {
  canonicalInputHash: 'stub-i', canonicalOutputHash: 'stub-o',
  canonicalizationVersion: 'stub-v', replayabilityStatus: 'REPLAYABLE', traceHash: 'stub-t',
};
/** 测试注入固定 ReplayMetadata（生产/真 launcher 不用）。 */
export function __setStubReplayMetadata(rm: Record<string, unknown>) { stubReplayMetadata = rm; }

/**
 * 处理 runner launch 请求。★真验 HMAC（重算 canonical v3 比 X-Internal-Signature，用独立 key）。
 * 验签失败 → 401/403；通过 → 返回 SUCCESS envelope（stub 固定 metadata）。
 */
export async function handleRunnerLaunch(request: Request): Promise<Response> {
  const key = process.env.ASTER_RUNNER_LAUNCHER_HMAC_KEY;
  if (!key) return new Response('launcher key 未配置', { status: 500 });

  const sig = request.headers.get('X-Internal-Signature');
  const timestamp = request.headers.get('X-Aster-Timestamp');
  const nonce = request.headers.get('X-Aster-Nonce');
  const caller = request.headers.get('X-Internal-Caller');
  const tenant = request.headers.get('X-Aster-Tenant');   // ★client 现放 header（Task 1 修复）
  const role = request.headers.get('X-Aster-Role');
  if (!sig || !timestamp || !nonce || caller !== 'cloud-runner-launcher' || tenant == null || role == null) {
    return new Response('缺签名头/caller 不符', { status: 401 });
  }
  // ★时间戳窗口（5min）先校验——过期请求 fail-fast，不做无谓 crypto（也避免 expired-vs-wrong-key
  //   的语义混淆）。★Number('abc')=NaN，Math.abs(NaN)>300=false 会误放行，故先 Number.isFinite。
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) {
    return new Response('时间戳无效或过期', { status: 401 });
  }

  const body = await request.text();
  const url = new URL(request.url);

  // ★重建与 client 逐字一致的 canonical v3（同 signRunnerLauncherHeaders，query/userId/businessRoles 为空）。
  //   tenant/role 从 header 取（client 放 header）。
  const canonical = await buildInternalCanonicalV3({
    method: request.method, path: url.pathname, timestamp, nonce, body, tenant, role,
  });

  // ★用 crypto.subtle.verify 常数时间原语验证（非手写 hex 比对——后者长度早退+逐字符泄时序）。
  //   验签失败 → 403（密钥隔离验证：错 key 签的 sig 对不上真 key 的 verify）。
  const ok = await hmacVerify(key, canonical, sig);
  if (!ok) return new Response('HMAC 验证失败', { status: 403 });

  return new Response(JSON.stringify({ outcome: 'SUCCESS', replayMetadata: stubReplayMetadata }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
}
