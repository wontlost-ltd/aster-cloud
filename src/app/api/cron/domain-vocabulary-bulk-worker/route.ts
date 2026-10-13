/**
 * POST /api/cron/domain-vocabulary-bulk-worker (B11)
 *
 * Async bulk-import worker. Each tick claims up to N queued jobs (default 4)
 * and processes one chunk per job — by design we DON'T loop chunks-per-job
 * here so the Cloudflare Workers time budget stays small.
 *
 * Triggers:
 *   - Cloudflare Workers `scheduled()` (primary; configured in wrangler.toml)
 *   - GitHub Actions / ops curl with the cron auth header (for backfill)
 *
 * The job table is the queue; claim safety comes from the
 * `UPDATE ... WHERE status='queued' ... RETURNING` pattern in
 * domain-vocabulary-jobs.ts. No external mutex is needed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireCronAuth } from '@/lib/cron-auth';
import { processQueuedBulkJobs } from '@/lib/domain-vocabulary-jobs';
import { parsePositiveInt } from '@/lib/api/query-params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest): Promise<NextResponse> {
  const guard = requireCronAuth(req);
  if (guard) return guard;

  const maxJobs = parsePositiveInt(
    new URL(req.url).searchParams.get('maxJobs'),
    parsePositiveInt(process.env.LEXICON_BULK_WORKER_MAX_JOBS ?? null, 4),
  );

  const workerId = `lexicon-bulk-${crypto.randomUUID().slice(0, 8)}`;
  try {
    const summary = await processQueuedBulkJobs({ workerId, maxJobs });
    return NextResponse.json({ ok: true, workerId, ...summary });
  } catch (error) {
    console.error('[domain-vocabulary-bulk-worker]', error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
