/**
 * POST /api/admin/lexicons/{id}
 *
 * 平台管理员开关某语种（lexicon）的全局可用性。body: `{ "action": "enable" | "disable" }`。
 *
 * 这是「aster-lang.cloud 管理员控制 aster-lang.dev 语言选项」的唯一控制面（ADR 0018）：
 *
 *   admin 勾选 → 本 BFF（requireAdmin 门禁）
 *     ↓ signLexiconAdminHeaders（8 行 canonical HMAC，密钥 ASTER_PLAN_GATE_HMAC_KEY）
 *   aster-api /api/v1/admin/lexicons/{id}/{action}
 *     ↓ LexiconRegistry.markUnavailable/markAvailable（全局，跨所有 replica + SSE 广播）
 *   /api/v1/lexicons 的 availableIds 变化
 *     ↓ 两端各自的语言切换器读 /api/v1/lexicons
 *   aster-lang.cloud 与 aster-lang.dev 切换器同步增减该语种（dev 零改动、无需重新部署）
 *
 * 「全局开关」语义（用户确认）：disable 某语种 = 该语种全面下线——不再提供 lexicon、
 * UI 文案（/api/v1/messages），也不能用该语种关键词编译策略（/evaluate-source）。
 *
 * 后端开关 = 单一真相：不再写 cloud 自有的 platform-settings.i18n.enabled_locales。
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { requireLicenseWriteOk } from '@/lib/license-write-gate';
import { signLexiconAdminHeaders } from '@/lib/api-signing';
import { uiLocaleToLexiconId } from '@/lib/lexicon-locale';
import { defaultLocale } from '@/i18n/config';
import { db, auditLogs } from '@/lib/prisma';
import { resolvePolicyApiBaseUrl } from '@/lib/policy-api-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ASTER_API_BASE =
  resolvePolicyApiBaseUrl(
    process.env.ASTER_POLICY_API_INTERNAL_URL,
    process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL,
  );

// 后端 sanitizeLocaleId 接受 BCP-47 形态（en-US / zh-CN / hi-IN）。在 BFF 这层先做
// 同样严格的白名单校验，避免把任意字符串透传进签名 path（path 进 canonical，污染
// 即签名无效，但提前 400 让错误更清晰，也防 SSRF 式路径拼接）。
const LEXICON_ID_RE = /^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$/;

// 默认语言的 lexicon id（en-US）。纵深防护：即便前端被绕过，也不能 disable
// 默认语言——否则 UI 失去可回退语种。
const DEFAULT_LEXICON_ID = uiLocaleToLexiconId(defaultLocale);

type Action = 'enable' | 'disable';

/** 记审计：成功与失败都落库，metadata 带 outcome（便于运维追溯每次开关结果）。 */
async function audit(
  userId: string,
  action: Action,
  id: string,
  outcome: string,
): Promise<void> {
  await db.insert(auditLogs).values({
    id: crypto.randomUUID(),
    userId,
    action: `lexicon.availability.${action}`,
    resource: 'lexicon',
    resourceId: id,
    metadata: { outcome },
    createdAt: new Date(),
  });
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // License gate top-level（lint 规则要求）：on-prem 过期/吊销 license 时禁止
  // 改平台语言可用性；SaaS 恒为 no-op。
  const writeGate = await requireLicenseWriteOk();
  if (writeGate) return writeGate;

  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  if (!LEXICON_ID_RE.test(id)) {
    return NextResponse.json({ error: 'invalid_lexicon_id' }, { status: 400 });
  }

  let action: Action;
  try {
    const body = (await req.json()) as { action?: unknown };
    if (body.action !== 'enable' && body.action !== 'disable') {
      return NextResponse.json({ error: 'invalid_action' }, { status: 400 });
    }
    action = body.action;
  } catch {
    return NextResponse.json({ error: 'invalid_body' }, { status: 400 });
  }

  // 纵深防护：禁止下线默认语言（前端已拦，这里再拦一道防 UI 绕过）。
  if (action === 'disable' && id === DEFAULT_LEXICON_ID) {
    await audit(admin.userId, action, id, 'rejected_default_locale');
    return NextResponse.json({ error: 'cannot_disable_default' }, { status: 400 });
  }

  const path = `/api/v1/admin/lexicons/${id}/${action}`;
  let upstream: Response;
  try {
    const headers = await signLexiconAdminHeaders('POST', path);
    upstream = await fetch(`${ASTER_API_BASE}${path}`, {
      method: 'POST',
      headers: { ...headers, Accept: 'application/json' },
    });
  } catch (err) {
    // 签名缺密钥 / 网络故障 → 502，不暴露内部细节
    console.error('[admin/lexicons] upstream call failed', err);
    await audit(admin.userId, action, id, 'upstream_unavailable');
    return NextResponse.json({ error: 'upstream_unavailable' }, { status: 502 });
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    // 只记 status，不把 upstream body 打进日志（后端未来可能返回敏感细节）。
    console.error(`[admin/lexicons] upstream ${action} ${id} → ${upstream.status}`);
    await audit(admin.userId, action, id, `upstream_rejected_${upstream.status}`);
    return NextResponse.json(
      { error: 'upstream_rejected', status: upstream.status },
      { status: 502 },
    );
  }

  // 后端返回 { status: "disabled"|"enabled"|"unchanged", id }
  let outcome = 'unknown';
  try {
    outcome = (JSON.parse(text) as { status?: string }).status ?? 'unknown';
  } catch {
    // 解析失败不致命，已知 upstream 2xx
  }

  await audit(admin.userId, action, id, outcome);
  return NextResponse.json({ id, action, outcome });
}
