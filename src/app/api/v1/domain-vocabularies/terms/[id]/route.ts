/**
 * /api/v1/domain-vocabularies/terms/[id]
 *
 * GET — read a single user term link
 * PATCH — modify (repoint) the link to a new or existing global term
 * DELETE — soft-delete the link (keeps DomainTerm for dedup reuse)
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
  getUserVocabularyTerm,
  modifyUserVocabularyTerm,
  softDeleteUserVocabularyTerm,
  type TermInput,
} from '@/lib/domain-vocabulary';

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
  // ★别名与描述区分「未提供」与「显式清空」：未提供（undefined）→ 服务层保持原值；
  //   null / [] / '' → 清空。防止任何前端漏带字段就把已存值清掉（第 4 轮生产复测）。
  const clearableString = (name: string, value: unknown): string | null | undefined => {
    if (value === null) return null;
    return optionalString(name, value);
  };
  const optionalAliases = (value: unknown): string[] | undefined => {
    if (value === undefined) return undefined;
    if (value === null) return [];
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
    description: clearableString('description', raw.description),
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
    default:
      return errorEnvelope({ status: 500, code: error.code, message: error.message });
  }
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_req: Request, { params }: RouteContext) {
  try {
    const session = await getSession();
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

    const term = await getUserVocabularyTerm(session.user.id, linkId, {
      includeDeleted: true,
    });
    if (!term) {
      return errorEnvelope({
        status: 404,
        code: 'not_found',
        message: 'Vocabulary term link not found',
      });
    }
    return NextResponse.json({ term });
  } catch (error) {
    console.error('[domain-vocabularies GET id]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not load the term. Please retry.',
    });
  }
}

export async function PATCH(req: Request, { params }: RouteContext) {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (error) {
    console.error('[domain-vocabularies PATCH] session lookup failed', error);
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

  try {
    const userId = session.user.id;
    const idem = await withIdempotency(
      req,
      { userId, routeKey: `PATCH /api/v1/domain-vocabularies/terms/${linkId}` },
      async () => {
        const result = await modifyUserVocabularyTerm(userId, linkId, input);
        return { status: 200, body: result };
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
    console.error('[domain-vocabularies PATCH]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not update the term. Please retry; the failure has been logged.',
    });
  }
}

export async function DELETE(req: Request, { params }: RouteContext) {
  let session: Awaited<ReturnType<typeof getSession>>;
  try {
    session = await getSession();
  } catch (error) {
    console.error('[domain-vocabularies DELETE] session lookup failed', error);
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

  let reason: string | undefined;
  if (req.headers.get('content-type')?.includes('application/json')) {
    try {
      const body = (await req.clone().json()) as { reason?: unknown };
      if (typeof body.reason === 'string') reason = body.reason;
    } catch {
      // Empty body or invalid JSON: treat as no reason. DELETE doesn't
      // require a body, so we don't 400 on it.
    }
  }

  try {
    const userId = session.user.id;
    const idem = await withIdempotency(
      req,
      { userId, routeKey: `DELETE /api/v1/domain-vocabularies/terms/${linkId}` },
      async () => {
        const result = await softDeleteUserVocabularyTerm(userId, linkId, reason);
        return { status: 200, body: { success: true, deletedAt: result.deletedAt.toISOString() } };
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
    console.error('[domain-vocabularies DELETE]', error);
    return errorEnvelope({
      status: 500,
      code: 'service_unavailable',
      message: 'Could not delete the term. Please retry; the failure has been logged.',
    });
  }
}
