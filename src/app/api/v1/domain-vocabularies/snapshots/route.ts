/**
 * GET /api/v1/domain-vocabularies/snapshots (B12)
 *
 * Returns the caller's own snapshots, paginated and optionally filtered
 * by domain + locale. Response shape matches the rest of the lexicon
 * list contracts: `{ snapshots: SnapshotListEntry[], total, page,
 * pageSize }` so the client can render <Pagination> without a second
 * round-trip.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { errorEnvelope } from '@/lib/api/error-envelope';
import { listOwnerSnapshots } from '@/lib/domain-vocabulary-snapshot';
import { parsePositiveInt } from '@/lib/api/query-params';

export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return errorEnvelope({
        status: 401,
        code: 'unauthorized',
        message: 'Sign in required',
      });
    }
    const url = new URL(req.url);
    const result = await listOwnerSnapshots(session.user.id, {
      domain: url.searchParams.get('domain') ?? undefined,
      locale: url.searchParams.get('locale') ?? undefined,
      page: parsePositiveInt(url.searchParams.get('page'), 1),
      pageSize: parsePositiveInt(url.searchParams.get('pageSize'), 25),
    });
    return NextResponse.json({
      snapshots: result.items,
      total: result.total,
      page: result.page,
      pageSize: result.pageSize,
    });
  } catch (error) {
    console.error('[domain-vocabularies snapshots GET]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not load snapshots. Please retry.',
    });
  }
}
