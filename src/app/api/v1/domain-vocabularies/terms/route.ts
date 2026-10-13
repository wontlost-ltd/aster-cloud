/**
 * /api/v1/domain-vocabularies/terms
 *
 * GET — list the caller's active vocabulary links (filter + paginate).
 * POST — add a new term link; supports ?dryRun=true to preview without
 *        writing, and the Idempotency-Key header for safe retries.
 *
 * All errors return the structured envelope from @/lib/api/error-envelope so
 * the BFF/UI can show traceable error IDs.
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
  addUserVocabularyTerm,
  listUserVocabularyTerms,
  previewAddTerm,
  type TermInput,
} from '@/lib/domain-vocabulary';
import { parsePositiveInt } from '@/lib/api/query-params';

const TERM_KINDS = ['struct', 'field', 'function', 'enum_value'] as const;

interface TermBody {
  domain?: unknown;
  locale?: unknown;
  kind?: unknown;
  canonical?: unknown;
  localized?: unknown;
  parentCanonical?: unknown;
  description?: unknown;
  aliases?: unknown;
}

function parseTermInput(raw: TermBody): TermInput {
  const required = (name: string, value: unknown): string => {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new VocabularyError('validation_failed', `${name} is required`);
    }
    return value;
  };
  const optionalString = (name: string, value: unknown): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      throw new VocabularyError('validation_failed', `${name} must be a string`);
    }
    return value;
  };
  const optionalAliases = (value: unknown): string[] | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
      throw new VocabularyError('validation_failed', 'aliases must be an array of strings');
    }
    return value as string[];
  };

  const kind = required('kind', raw.kind);
  if (!TERM_KINDS.includes(kind as (typeof TERM_KINDS)[number])) {
    throw new VocabularyError(
      'validation_failed',
      `kind must be one of ${TERM_KINDS.join(', ')}`,
    );
  }

  return {
    domain: required('domain', raw.domain),
    locale: required('locale', raw.locale),
    kind: kind as TermInput['kind'],
    canonical: required('canonical', raw.canonical),
    localized: required('localized', raw.localized),
    parentCanonical: optionalString('parentCanonical', raw.parentCanonical),
    description: optionalString('description', raw.description),
    aliases: optionalAliases(raw.aliases),
  };
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
    case 'not_found':
      return errorEnvelope({ status: 404, code: error.code, message: error.message });
    case 'dedup_race_lost':
    case 'link_create_failed':
    case 'restore_failed':
    case 'internal_error':
    default:
      return errorEnvelope({ status: 500, code: error.code, message: error.message });
  }
}

export async function GET(req: Request) {
  try {
    const session = await getSession();
    if (!session?.user?.id) {
      return errorEnvelope({ status: 401, code: 'unauthorized', message: 'Sign in required' });
    }

    const url = new URL(req.url);
    const includeDeleted = url.searchParams.get('includeDeleted') === 'true';
    const result = await listUserVocabularyTerms(session.user.id, {
      domain: url.searchParams.get('domain') ?? undefined,
      locale: url.searchParams.get('locale') ?? undefined,
      kind: url.searchParams.get('kind') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      includeDeleted,
      page: parsePositiveInt(url.searchParams.get('page'), 1),
      pageSize: parsePositiveInt(url.searchParams.get('pageSize'), 50),
    });

    return NextResponse.json(result);
  } catch (error) {
    console.error('[domain-vocabularies GET]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not load your vocabulary. Please retry; the failure has been logged.',
    });
  }
}

export async function POST(req: Request) {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (error) {
    console.error('[domain-vocabularies POST] session lookup failed', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Authentication check failed. Please retry.',
    });
  }
  if (!session?.user?.id) {
    return errorEnvelope({ status: 401, code: 'unauthorized', message: 'Sign in required' });
  }

  let parsedBody: TermBody;
  try {
    parsedBody = (await req.clone().json()) as TermBody;
  } catch {
    return errorEnvelope({
      status: 400,
      code: 'validation_failed',
      message: 'Request body must be valid JSON',
    });
  }

  let input: TermInput;
  try {
    input = parseTermInput(parsedBody);
  } catch (error) {
    if (error instanceof VocabularyError) return vocabErrorToEnvelope(error);
    throw error;
  }

  const url = new URL(req.url);
  if (url.searchParams.get('dryRun') === 'true') {
    try {
      const preview = await previewAddTerm(session.user.id, input);
      return NextResponse.json({ dryRun: true, ...preview });
    } catch (error) {
      if (error instanceof VocabularyError) return vocabErrorToEnvelope(error);
      console.error('[domain-vocabularies POST dryRun]', error);
      return errorEnvelope({
        status: 500,
        code: 'service_unavailable',
        message: 'Could not preview the term. Please retry.',
      });
    }
  }

  try {
    const userId = session.user.id;
    const idem = await withIdempotency(
      req,
      { userId, routeKey: 'POST /api/v1/domain-vocabularies/terms' },
      async () => {
        const result = await addUserVocabularyTerm(userId, input);
        return { status: 201, body: result };
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
    console.error('[domain-vocabularies POST]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not save the term. Please retry; the failure has been logged.',
    });
  }
}
