/**
 * BYOK endpoint allowlist 管理端点（平台管理员）。
 *
 * GET  /api/admin/byok-allowlist            → 列出当前 allowlist（builtin/env/dynamic 来源标注）
 * POST /api/admin/byok-allowlist { action: "add"|"remove", host }  → 增删动态 host
 *
 * 控制面链路（同 lexicon admin，ADR 0018）：
 *   admin UI → 本 BFF（requireAdmin 门禁）
 *     ↓ signByokAllowlistHeaders（AdminHmacVerifier canonical，密钥 ASTER_PLAN_GATE_HMAC_KEY）
 *   aster-api /api/v1/admin/byok-allowlist
 *     ↓ ByokAllowlistService（Redis SET 真相源 + pub/sub 广播，跨所有 replica 即时生效）
 *   LlmEndpointPolicy allowlist 变化 → 用户 BYOK 自定义 Provider URL 立即可用（零 CI/零重启）
 *
 * 安全：allowlist 是 aster-api 出站 SSRF 边界（全平台共享攻击面），批准权是平台管理员。
 * add 的 host 由 aster-api 侧 SsrfGuard 校验（私网/元数据 deny），本 BFF 只做 admin 门禁 + 签名转发。
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { signByokAllowlistHeaders } from '@/lib/api-signing';
import { db, auditLogs } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASTER_API_BASE =
  process.env.ASTER_POLICY_API_INTERNAL_URL ||
  process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL ||
  'https://policy.aster-lang.dev';

const UPSTREAM_PATH = '/api/v1/admin/byok-allowlist';

async function audit(
  userId: string,
  action: string,
  host: string,
  outcome: string,
): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId,
      action: `byok.allowlist.${action}`,
      resource: 'byok-allowlist',
      resourceId: host,
      metadata: { outcome },
    });
  } catch {
    // 审计失败不阻断主流程（与 lexicon admin 一致）。
  }
}

export async function GET() {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  try {
    const headers = await signByokAllowlistHeaders('GET', UPSTREAM_PATH, null);
    const resp = await fetch(`${ASTER_API_BASE}${UPSTREAM_PATH}`, {
      method: 'GET',
      headers: { ...headers },
      cache: 'no-store',
    });
    const text = await resp.text();
    return new NextResponse(text, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('content-type') || 'application/json' },
    });
  } catch {
    return NextResponse.json(
      { error: 'upstream_unavailable', message: 'Could not connect to the upstream allowlist service.' },
      { status: 502 },
    );
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  // SaaS license write gate（同 lexicon admin）：写操作在无效/过期 license 下 503 拒绝。
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;

  const bodyJson = (await req.json().catch(() => null)) as
    | { action?: unknown; host?: unknown }
    | null;
  // 类型守卫：非字符串 action/host（如 {host:123}）返回 400，不让 .trim() TypeError 成 500。
  const action =
    typeof bodyJson?.action === 'string' ? bodyJson.action.trim().toLowerCase() : '';
  const host = typeof bodyJson?.host === 'string' ? bodyJson.host.trim() : '';
  if (action !== 'add' && action !== 'remove') {
    return NextResponse.json(
      { error: 'invalid_action', message: 'action must be add or remove.' },
      { status: 400 },
    );
  }
  if (!host) {
    return NextResponse.json(
      { error: 'host_required', message: 'host is required.' },
      { status: 400 },
    );
  }

  // 序列化后签名 + 转发同一份 body（sha256 覆盖此 body）。
  const body = JSON.stringify({ action, host });
  try {
    const headers = await signByokAllowlistHeaders('POST', UPSTREAM_PATH, body);
    const resp = await fetch(`${ASTER_API_BASE}${UPSTREAM_PATH}`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body,
      cache: 'no-store',
    });
    const text = await resp.text();
    await audit(admin.userId, action, host, resp.ok ? 'success' : `http_${resp.status}`);
    return new NextResponse(text, {
      status: resp.status,
      headers: { 'Content-Type': resp.headers.get('content-type') || 'application/json' },
    });
  } catch {
    // 签名密钥缺失 / 网络错误：502 + 审计（不泄内部细节，同 lexicon admin）。
    await audit(admin.userId, action, host, 'upstream_unavailable');
    return NextResponse.json(
      { error: 'upstream_unavailable', message: 'Could not connect to the upstream allowlist service. Try again later.' },
      { status: 502 },
    );
  }
}
