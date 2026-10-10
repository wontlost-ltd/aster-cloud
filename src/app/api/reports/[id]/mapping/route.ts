import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/auth';
import { getEvidenceExport } from '@/lib/evidence';
import { readStoredEvidenceExport, type StoredEvidenceExport } from '@/services/evidence/stored';

// v1–v3 不含注册表驱动的对照：如实返回 null，由 UI 显示「此版本不含对照」；v5 另附所用治理档案（ADR 0046 §6）
function mappingOf(stored: StoredEvidenceExport | null) {
  const manifest = stored?.manifest;
  if (manifest?.schemaVersion === '5') return { ...manifest.regulatoryMapping, profilesUsed: manifest.profilesUsed };
  return manifest?.schemaVersion === '4' ? manifest.regulatoryMapping : null;
}

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
  return NextResponse.json({ mapping: mappingOf(readStoredEvidenceExport(report.data)) });
}
