import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getEvidenceExport } from '@/lib/evidence';
import { readStoredEvidenceExport } from '@/services/evidence/stored';

// GET /api/reports/[id]/mapping — 证据包内注册表驱动的法规对照（ADR 0045 §5），供报告页展开查看。
// 归属校验与下载/元数据接口一致：只查本人的证据导出行，miss/越权统一 404。
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { id } = await params;
  const report = await getEvidenceExport(session.user.id, id);
  if (!report) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  // 不卡 status === 'completed'：未完成行尚无 manifest，readStoredEvidenceExport 返回 null，自然得到 mapping: null
  const stored = readStoredEvidenceExport(report.data);
  // v1–v3 不含注册表驱动的对照：如实返回 null，由 UI 显示「此版本不含对照」
  const mapping = stored && stored.manifest.schemaVersion === '4' ? stored.manifest.regulatoryMapping : null;
  return NextResponse.json({ mapping });
}
