/**
 * POST /api/v1/domain-vocabularies/bulk
 *
 * Synchronous bulk import (≤500 rows). Larger payloads should use
 * /bulk/jobs (B11) instead, which queues an async worker.
 *
 * The handler enforces a 5/hour/user rate limit (RateLimitPresets.LEXICON_BULK)
 * before any DB work, then delegates row-level validation/upsert/quota
 * accounting to bulkAddUserVocabularyTerms. The service always returns a
 * BulkResult — partial failures are reported as row-level errors rather than
 * a top-level throw.
 *
 * 响应计数口径（added / reused / skipped 与 errors[].code 的对应关系）见
 * src/lib/domain-vocabulary.ts 的 BulkRollup：「已在你的词汇中」的行是 skipped（duplicate_link），
 * 不是 reused；reused 表示复用已有全局词条并为你新建链接。
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
  BULK_SYNC_MAX_ROWS,
  VocabularyError,
  bulkAddUserVocabularyTerms,
  type TermInput,
} from '@/lib/domain-vocabulary';
import {
  RateLimitPresets,
  checkRateLimit,
  getRateLimitHeaders,
} from '@/lib/rate-limit';

const TERM_KINDS = ['struct', 'field', 'function', 'enum_value'] as const;

interface RawTerm {
  domain?: unknown;
  locale?: unknown;
  kind?: unknown;
  canonical?: unknown;
  localized?: unknown;
  parentCanonical?: unknown;
  description?: unknown;
  aliases?: unknown;
}

interface BulkRequestBody {
  terms?: unknown;
}

function parseTerms(raw: BulkRequestBody): TermInput[] {
  if (!raw || !Array.isArray(raw.terms)) {
    throw new VocabularyError(
      'validation_failed',
      'request body must include a "terms" array',
    );
  }
  if (raw.terms.length === 0) {
    throw new VocabularyError('validation_failed', '"terms" must not be empty');
  }
  if (raw.terms.length > BULK_SYNC_MAX_ROWS) {
    throw new VocabularyError(
      'validation_failed',
      `sync bulk import accepts at most ${BULK_SYNC_MAX_ROWS} rows; ` +
        'use /bulk/jobs for larger payloads',
    );
  }

  return raw.terms.map((entry, index): TermInput => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new VocabularyError(
        'validation_failed',
        `terms[${index}] must be an object`,
      );
    }
    const t = entry as RawTerm;
    const required = (name: string, value: unknown): string => {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new VocabularyError(
          'validation_failed',
          `terms[${index}].${name} is required`,
        );
      }
      return value;
    };
    const optionalString = (name: string, value: unknown): string | undefined => {
      if (value === undefined || value === null) return undefined;
      if (typeof value !== 'string') {
        throw new VocabularyError(
          'validation_failed',
          `terms[${index}].${name} must be a string`,
        );
      }
      return value;
    };
    const optionalAliases = (value: unknown): string[] | undefined => {
      if (value === undefined || value === null) return undefined;
      if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
        throw new VocabularyError(
          'validation_failed',
          `terms[${index}].aliases must be an array of strings`,
        );
      }
      return value as string[];
    };

    const kind = required('kind', t.kind);
    if (!TERM_KINDS.includes(kind as (typeof TERM_KINDS)[number])) {
      throw new VocabularyError(
        'validation_failed',
        `terms[${index}].kind must be one of ${TERM_KINDS.join(', ')}`,
      );
    }

    return {
      domain: required('domain', t.domain),
      locale: required('locale', t.locale),
      kind: kind as TermInput['kind'],
      canonical: required('canonical', t.canonical),
      localized: required('localized', t.localized),
      parentCanonical: optionalString('parentCanonical', t.parentCanonical),
      description: optionalString('description', t.description),
      aliases: optionalAliases(t.aliases),
    };
  });
}

function vocabErrorToEnvelope(error: VocabularyError): NextResponse {
  switch (error.code) {
    case 'plan_gate_required':
      return errorEnvelope({ status: 403, code: error.code, message: error.message });
    case 'quota_exceeded':
    case 'duplicate_link':
      return errorEnvelope({ status: 422, code: error.code, message: error.message });
    case 'validation_failed':
      return errorEnvelope({ status: 400, code: error.code, message: error.message });
    default:
      return errorEnvelope({ status: 500, code: error.code, message: error.message });
  }
}

export async function POST(req: Request) {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (error) {
    console.error('[domain-vocabularies bulk] session lookup failed', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Authentication check failed. Please retry.',
    });
  }
  if (!session?.user?.id) {
    return errorEnvelope({
      status: 401,
      code: 'unauthorized',
      message: 'Sign in required',
    });
  }

  const userId = session.user.id;

  // Per-user 5/hour rate limit before any DB IO so spammers don't pay for
  // our row-validation cycles.
  const rate = checkRateLimit(`lexicon-bulk:${userId}`, RateLimitPresets.LEXICON_BULK);
  if (!rate.allowed) {
    return errorEnvelope({
      status: 429,
      code: 'rate_limited',
      message: 'Too many bulk imports — please retry after the window resets.',
      headers: getRateLimitHeaders(rate, RateLimitPresets.LEXICON_BULK),
    });
  }

  let parsedBody: BulkRequestBody;
  try {
    parsedBody = (await req.clone().json()) as BulkRequestBody;
  } catch {
    return errorEnvelope({
      status: 400,
      code: 'validation_failed',
      message: 'Request body must be valid JSON',
    });
  }

  let terms: TermInput[];
  try {
    terms = parseTerms(parsedBody);
  } catch (error) {
    if (error instanceof VocabularyError) return vocabErrorToEnvelope(error);
    throw error;
  }

  try {
    const idem = await withIdempotency(
      req,
      { userId, routeKey: 'POST /api/v1/domain-vocabularies/bulk' },
      async () => {
        const result = await bulkAddUserVocabularyTerms(userId, terms);
        return { status: 200, body: result };
      },
    );
    return NextResponse.json(idem.body, {
      status: idem.status,
      headers: getRateLimitHeaders(rate, RateLimitPresets.LEXICON_BULK),
    });
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return errorEnvelope({ status: 409, code: error.code, message: error.message });
    }
    if (error instanceof IdempotencyKeyInvalidError) {
      return errorEnvelope({ status: 400, code: error.code, message: error.message });
    }
    if (error instanceof VocabularyError) return vocabErrorToEnvelope(error);
    console.error('[domain-vocabularies bulk]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not process the bulk import. Please retry; the failure has been logged.',
    });
  }
}
