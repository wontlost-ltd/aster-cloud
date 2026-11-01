/**
 * DELETE /api/admin/pilot-applications/{id} —— 管理员删除单条试点申请（仅 SaaS、仅平台 admin）。
 *
 * 用于响应申请人的删除请求或清理垃圾提交；写一条审计日志（只记申请 id，不记邮箱等内容）。
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { logAuditEvent } from '@/lib/audit-log';
import { IS_SAAS } from '@/lib/deployment-mode';
import { deletePilotApplication } from '@/lib/pilot-applications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  if (!IS_SAAS) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  if (!(await deletePilotApplication(id))) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  await logAuditEvent({
    userId: admin.userId,
    action: 'pilot-application.delete',
    resource: 'pilot-application',
    resourceId: id,
  });
  return new Response(null, { status: 204 });
}
