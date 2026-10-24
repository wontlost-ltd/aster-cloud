import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { signByokAllowlistHeaders } from '@/lib/api-signing';
import { extractClientInfo, logAuditEvent } from '@/lib/audit-log';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = process.env.ASTER_POLICY_API_INTERNAL_URL || process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL || 'https://policy.aster-lang.dev';

async function proxy(req: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { path } = await context.params;
  const suffix = path.join('/');
  if (!(suffix === 'runs' || /^runs\/[A-Za-z0-9_-]+$/.test(suffix) || suffix === 'invalid')) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  // 签名只覆盖路径，不含查询串（api 侧 AdminHmacVerifier 用的是 @Path 常量）；查询串只拼到实际请求 URL。
  const signPath = `/api/v1/admin/revalidation/${suffix}`;
  const upstreamPath = `${signPath}${req.nextUrl.search}`;
  // 发起重验是全平台生效的管理员动作（失效版本随后 fail-closed 422）：把 cloud 已验证的管理员 id 以
  // requestedBy 带给 api 落到 policy_revalidation_run.triggered_by，并在 cloud 侧写 AuditLog，与 ai-circuit.trip、
  // auth.db_epoch.bump 等其它管理员变更同一留痕口径。只读（runs/{id}、invalid）不审计。
  const isStart = req.method === 'POST' && suffix === 'runs';
  const requested = isStart ? await parseStartBody(req) : null;
  if (isStart && requested === null) return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
  const body = isStart ? JSON.stringify({ ...requested, requestedBy: admin.userId }) : null;
  try {
    const headers: Record<string, string> = { ...await signByokAllowlistHeaders(req.method, signPath, body) };
    if (body) headers['Content-Type'] = 'application/json';
    const upstream = await fetch(`${API_BASE}${upstreamPath}`, { method: req.method, headers, body: body || undefined, cache: 'no-store' });
    const text = await upstream.text();
    if (isStart && upstream.ok) await auditStart(req, admin.userId, requested ?? {}, text);
    return new NextResponse(text, { status: upstream.status, headers: { 'Content-Type': upstream.headers.get('content-type') || 'application/json' } });
  } catch {
    return NextResponse.json({ error: 'upstream_unavailable', message: '无法连接后端重验服务。' }, { status: 502 });
  }
}

// 发起请求体必须是 JSON 对象（要往里追加 requestedBy）；非法 JSON / 非对象返回 null，由调用方回 400，不静默改写。
async function parseStartBody(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await req.text());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// 审计写入失败只记日志：重验已在 api 侧入队，不能把成功的操作报成失败让管理员重复点击。
async function auditStart(req: NextRequest, userId: string, requested: Record<string, unknown>, upstreamText: string): Promise<void> {
  let runId: unknown;
  try { runId = (JSON.parse(upstreamText) as { runId?: unknown }).runId; } catch { runId = undefined; }
  try {
    await logAuditEvent({
      userId,
      action: 'policy.revalidation.started',
      resource: 'revalidation-run',
      resourceId: runId === undefined || runId === null ? undefined : String(runId),
      metadata: { scope: requested.scope ?? 'all', tenantId: requested.tenantId ?? null, operatorId: userId },
      ...extractClientInfo(req),
    });
  } catch (err) {
    console.error('[admin/revalidation] audit write failed', err instanceof Error ? err.message : String(err));
  }
}

export const GET = proxy;
export const POST = proxy;
