/**
 * /api/v1/domain-vocabularies/terms/[id]/restore
 *
 * Reactivate a soft-deleted vocabulary link (within the 24h restore window,
 * before the retention cron archives it). Archived rows must use a separate
 * recovery flow.
 */

import { NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { errorEnvelope } from '@/lib/api/error-envelope';
import {
  IdempotencyConflictError,
  IdempotencyKeyInvalidError,
  withIdempotency,
} from '@/lib/api/idempotency';
import {
  VocabularyError,
  restoreUserVocabularyTerm,
} from '@/lib/domain-vocabulary';
import { resolveVocabularyOwner, teamIdFromRequest } from '@/lib/domain-vocabulary-team';

function vocabErrorToEnvelope(error: VocabularyError): NextResponse {
  switch (error.code) {
    case 'not_found':
      return errorEnvelope({ status: 404, code: error.code, message: error.message });
    case 'team_forbidden':
    case 'team_role_insufficient':
      return errorEnvelope({ status: 403, code: error.code, message: error.message });
    case 'restore_failed':
      return errorEnvelope({ status: 409, code: error.code, message: error.message });
    default:
      return errorEnvelope({ status: 500, code: error.code, message: error.message });
  }
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(req: Request, { params }: RouteContext) {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (error) {
    console.error('[domain-vocabularies restore] session lookup failed', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Authentication check failed. Please retry.',
    });
  }
  if (!session?.user?.id) {
    return errorEnvelope({ status: 401, code: 'unauthorized', message: 'Sign in required' });
  }

  const { id: linkId } = await params;
  if (!linkId) {
    return errorEnvelope({
      status: 400,
      code: 'validation_failed',
      message: 'linkId is required',
    });
  }

  try {
    const userId = session.user.id;
    const owner = await resolveVocabularyOwner(userId, teamIdFromRequest(req), 'edit', linkId);
    const idem = await withIdempotency(
      req,
      { userId, routeKey: `POST /api/v1/domain-vocabularies/terms/${linkId}/restore` },
      async () => {
        const result = await restoreUserVocabularyTerm(userId, linkId, owner);
        return {
          status: 200,
          body: { link: result.link, restoredAt: new Date().toISOString() },
        };
      },
    );
    return NextResponse.json(idem.body, { status: idem.status });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return errorEnvelope({ status: 409, code: error.code, message: error.message });
    }
    if (error instanceof IdempotencyKeyInvalidError) {
      return errorEnvelope({ status: 400, code: error.code, message: error.message });
    }
    if (error instanceof VocabularyError) return vocabErrorToEnvelope(error);
    console.error('[domain-vocabularies restore]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not restore the term. Please retry; the failure has been logged.',
    });
  }
}
