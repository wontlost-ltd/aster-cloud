/**
 * GET /api/admin/pilot-applications/export —— 试点申请 CSV 导出（仅 SaaS、仅平台 admin）。
 */
import { NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/admin-auth';
import { IS_SAAS } from '@/lib/deployment-mode';
import { listPilotApplications, pilotApplicationsToCsv } from '@/lib/pilot-applications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  if (!IS_SAAS) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  const csv = pilotApplicationsToCsv(await listPilotApplications());
  const date = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="pilot-applications-${date}.csv"`,
      'Cache-Control': 'private, no-store, max-age=0',
    },
  });
}
