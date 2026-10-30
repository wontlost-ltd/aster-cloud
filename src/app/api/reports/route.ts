import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { hasFeatureAccess, recordUsage, EVIDENCE_EXPORT_METRIC } from '@/lib/usage';
import { createEvidenceExport, listEvidenceExports } from '@/lib/evidence';
import { getEvidencePreview, EvidenceTooLargeError } from '@/lib/evidence-export';
import type { EvidenceFormat } from '@/services/evidence/types';
import { loadPolicyForAction } from '@/lib/policy-access';

// GET /api/reports — 列出用户的证据导出历史。
export async function GET() {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const exports = await listEvidenceExports(session.user.id);
    return NextResponse.json(exports);
  } catch (error) {
    console.error('Error listing evidence exports:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

interface ExportBody {
  policyId?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  format?: string;
  /** true = 只预览规模（count + decision 分布 + 覆盖率），不生成导出。 */
  dryRun?: boolean;
  /** true = 仅导有可验证哈希的执行（排除 legacy 无哈希行）。 */
  verifiableOnly?: boolean;
}

// POST /api/reports — 生成证据导出（或 dryRun 预览）。付费门控 Pro/Team。
export async function POST(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // 付费门控（证据导出仍限 Pro/Team；能力键=evidenceExport，持久计量值仍 compliance_report）。
    const hasAccess = await hasFeatureAccess(session.user.id, 'evidenceExport');
    if (!hasAccess) {
      return NextResponse.json(
        { error: 'Evidence export requires a Pro or Team subscription', upgrade: true },
        { status: 403 }
      );
    }

    const body = (await req.json()) as ExportBody;

    // 校验 policyId（可选，字符串）。
    const policyId = typeof body.policyId === 'string' && body.policyId.length > 0 ? body.policyId : undefined;

    // 校验日期（可选，ISO；start<=end）。
    let startDate: Date | undefined;
    let endDate: Date | undefined;
    if (body.startDate) {
      const d = new Date(body.startDate);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid startDate' }, { status: 400 });
      }
      startDate = d;
    }
    if (body.endDate) {
      const d = new Date(body.endDate);
      if (Number.isNaN(d.getTime())) {
        return NextResponse.json({ error: 'Invalid endDate' }, { status: 400 });
      }
      endDate = d;
    }
    if (startDate && endDate && startDate.getTime() > endDate.getTime()) {
      return NextResponse.json({ error: 'startDate must be before endDate' }, { status: 400 });
    }

    // 预览（dryRun）：回 count + decision 分布 + **覆盖率**（不带 verifiableOnly——预览要展示全量的
    // verifiable/legacy 拆分，让用户据此决定是否勾「仅可验证」）。
    if (body.dryRun) {
      // 单策略预览与导出同一授权：团队策略任一当前成员，个人策略只认所有者；其余 404
      if (policyId && !(await loadPolicyForAction(policyId, { userId: session.user.id }, 'view')).ok) {
        return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
      }
      const preview = await getEvidencePreview({ userId: session.user.id, policyId, startDate, endDate });
      return NextResponse.json(preview);
    }

    // 格式校验。
    const format: EvidenceFormat = body.format === 'jsonl' ? 'jsonl' : 'json';

    try {
      const { id, manifest } = await createEvidenceExport(session.user.id, {
        policyId,
        startDate,
        endDate,
        format,
        verifiableOnly: body.verifiableOnly === true,
      });
      // 计量（值仍 compliance_report，向后兼容——见 usage.ts EVIDENCE_EXPORT_METRIC）。
      await recordUsage(session.user.id, EVIDENCE_EXPORT_METRIC);
      return NextResponse.json({ id, manifest }, { status: 201 });
    } catch (err) {
      if (err instanceof EvidenceTooLargeError) {
        return NextResponse.json(
          { error: 'Too many executions in range; narrow the time range or select a single policy', count: err.count, limit: err.limit },
          { status: 413 }
        );
      }
      if (err instanceof Error && err.message === 'policy_not_found') {
        return NextResponse.json({ error: 'Policy not found' }, { status: 404 });
      }
      throw err;
    }
  } catch (error) {
    console.error('Error generating evidence export:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
