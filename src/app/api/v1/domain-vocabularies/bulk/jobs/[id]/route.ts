/**
 * /api/v1/domain-vocabularies/bulk/jobs/[id] (B11)
 *
 * GET    — read job progress + rollup + errors（rollup 口径同同步导入，见 domain-vocabulary.ts BulkRollup）
 * DELETE — cancel the job (queued or running). Workers honour the flip at
 *          chunk boundaries.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { errorEnvelope } from '@/lib/api/error-envelope';
import { cancelBulkJob, getBulkJob } from '@/lib/domain-vocabulary-jobs';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return errorEnvelope({ status: 401, code: 'unauthorized', message: 'Sign in required' });
    }
    const { id } = await params;
    if (!id) {
      return errorEnvelope({
        status: 400,
        code: 'validation_failed',
        message: 'jobId is required',
      });
    }
    const job = await getBulkJob(session.user.id, id);
    if (!job) {
      return errorEnvelope({ status: 404, code: 'not_found', message: 'Bulk job not found' });
    }
    return NextResponse.json({ job });
  } catch (error) {
    console.error('[domain-vocabularies bulk job GET]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not load the bulk job. Please retry.',
    });
  }
}

export async function DELETE(_req: Request, { params }: RouteContext) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return errorEnvelope({ status: 401, code: 'unauthorized', message: 'Sign in required' });
    }
    const { id } = await params;
    if (!id) {
      return errorEnvelope({
        status: 400,
        code: 'validation_failed',
        message: 'jobId is required',
      });
    }
    const result = await cancelBulkJob(session.user.id, id);
    if (!result.cancelled) {
      // Either job missing or already terminal. We return 404 either way so
      // the UI can refresh without leaking job state.
      return errorEnvelope({
        status: 404,
        code: 'not_found',
        message: 'Bulk job not found or already terminal',
      });
    }
    return NextResponse.json({ cancelled: true });
  } catch (error) {
    console.error('[domain-vocabularies bulk job DELETE]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not cancel the bulk job. Please retry.',
    });
  }
}
