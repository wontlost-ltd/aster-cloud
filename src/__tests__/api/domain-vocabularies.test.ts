/**
 * Route-handler tests for /api/v1/domain-vocabularies/terms[*].
 *
 * We mock the service layer (`@/lib/domain-vocabulary`), the auth helper, and
 * idempotency middleware so the tests verify shape contracts:
 *   - 401 for unauthenticated calls
 *   - 400 / 422 / 403 / 404 envelope codes from VocabularyError
 *   - 201/200 success bodies
 *   - dryRun branch surfaces previewAddTerm
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({
  getSession: vi.fn(),
}));

vi.mock('@/lib/api/idempotency', async (orig) => {
  const original = (await orig()) as Record<string, unknown>;
  return {
    ...original,
    withIdempotency: vi.fn(async (_req: Request, _opts, handler: () => Promise<unknown>) => {
      const result = (await handler()) as { status: number; body: unknown };
      return { ...result, replayed: false };
    }),
  };
});

vi.mock('@/lib/domain-vocabulary', async (orig) => {
  const original = (await orig()) as Record<string, unknown>;
  return {
    ...original,
    addUserVocabularyTerm: vi.fn(),
    modifyUserVocabularyTerm: vi.fn(),
    softDeleteUserVocabularyTerm: vi.fn(),
    restoreUserVocabularyTerm: vi.fn(),
    listUserVocabularyTerms: vi.fn(),
    getUserVocabularyTerm: vi.fn(),
    previewAddTerm: vi.fn(),
  };
});

import { GET as listTerms, POST as createTerm } from '@/app/api/v1/domain-vocabularies/terms/route';
import {
  GET as getTerm,
  PATCH as patchTerm,
  DELETE as deleteTerm,
} from '@/app/api/v1/domain-vocabularies/terms/[id]/route';
import { POST as restoreTerm } from '@/app/api/v1/domain-vocabularies/terms/[id]/restore/route';
import { getSession } from '@/lib/auth';
import {
  VocabularyError,
  addUserVocabularyTerm,
  getUserVocabularyTerm,
  listUserVocabularyTerms,
  modifyUserVocabularyTerm,
  previewAddTerm,
  restoreUserVocabularyTerm,
  softDeleteUserVocabularyTerm,
} from '@/lib/domain-vocabulary';

function mockSession(userId: string | null) {
  if (userId === null) {
    vi.mocked(getSession).mockResolvedValue(null as unknown as Awaited<ReturnType<typeof getSession>>);
  } else {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: userId },
    } as unknown as Awaited<ReturnType<typeof getSession>>);
  }
}

function postRequest(body: unknown, params: Record<string, string> = {}) {
  const url = new URL('http://localhost/api/v1/domain-vocabularies/terms');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

const validTerm = {
  domain: 'finance.loan',
  locale: 'en-US',
  kind: 'struct',
  canonical: 'Loan',
  localized: 'Loan',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockSession('user-1');
});

describe('GET /api/v1/domain-vocabularies/terms', () => {
  it('returns 401 when unauthenticated', async () => {
    mockSession(null);

    const res = await listTerms(new Request('http://localhost/api/v1/domain-vocabularies/terms'));
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.error.code).toBe('unauthorized');
  });

  it('returns the service result on success', async () => {
    vi.mocked(listUserVocabularyTerms).mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 50,
      archivedCount: 0,
    });

    const res = await listTerms(
      new Request('http://localhost/api/v1/domain-vocabularies/terms?domain=finance.loan&page=1'),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.total).toBe(0);
    expect(vi.mocked(listUserVocabularyTerms)).toHaveBeenCalledWith('user-1', expect.objectContaining({
      domain: 'finance.loan',
      page: 1,
    }));
  });

  it('passes the deleted-only 90-day view through the session-authenticated list route', async () => {
    vi.mocked(listUserVocabularyTerms).mockResolvedValue({
      items: [], total: 0, page: 2, pageSize: 200, archivedCount: 0,
    });
    const res = await listTerms(new Request('http://localhost/api/v1/domain-vocabularies/terms?deletedOnly=true&page=2&pageSize=200'));
    expect(res.status).toBe(200);
    expect(vi.mocked(listUserVocabularyTerms)).toHaveBeenCalledWith('user-1', expect.objectContaining({
      deletedOnly: true,
      page: 2,
      pageSize: 200,
    }));
  });

  it('maps service failure to a 500 envelope', async () => {
    vi.mocked(listUserVocabularyTerms).mockRejectedValue(new Error('boom'));

    const res = await listTerms(new Request('http://localhost/api/v1/domain-vocabularies/terms'));
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe('service_unavailable');
  });
});

describe('POST /api/v1/domain-vocabularies/terms', () => {
  it('returns 400 for invalid JSON', async () => {
    const req = new Request('http://localhost/api/v1/domain-vocabularies/terms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const res = await createTerm(req);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
  });

  it('returns 400 for missing required fields', async () => {
    const res = await createTerm(postRequest({ domain: 'x' }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
  });

  it('returns 400 for unknown kind', async () => {
    const res = await createTerm(postRequest({ ...validTerm, kind: 'concept' }));
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('validation_failed');
  });

  it('returns 201 with the new link on success', async () => {
    vi.mocked(addUserVocabularyTerm).mockResolvedValue({
      link: {
        id: 'link-1',
        termId: 'term-1',
        userId: 'user-1',
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'struct',
        canonical: 'Loan',
        localized: 'Loan',
        parentCanonical: null,
        aliases: [],
        description: null,
        source: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      createdGlobalTerm: true,
    });

    const res = await createTerm(postRequest(validTerm));
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.link.id).toBe('link-1');
  });

  it('returns 403 when the service throws plan_gate_required', async () => {
    vi.mocked(addUserVocabularyTerm).mockRejectedValue(
      new VocabularyError('plan_gate_required', 'Upgrade required'),
    );

    const res = await createTerm(postRequest(validTerm));
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe('plan_gate_required');
  });

  it('returns 422 when quota is exceeded', async () => {
    vi.mocked(addUserVocabularyTerm).mockRejectedValue(
      new VocabularyError('quota_exceeded', 'Limit reached'),
    );

    const res = await createTerm(postRequest(validTerm));
    const body = await res.json();

    expect(res.status).toBe(422);
    expect(body.error.code).toBe('quota_exceeded');
  });

  it('surfaces previewAddTerm when ?dryRun=true', async () => {
    vi.mocked(previewAddTerm).mockResolvedValue({
      existsInGlobal: true,
      existingTermId: 'term-existing',
      collisions: [],
    });

    const res = await createTerm(postRequest(validTerm, { dryRun: 'true' }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.existsInGlobal).toBe(true);
    expect(vi.mocked(addUserVocabularyTerm)).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/v1/domain-vocabularies/terms/[id]', () => {
  it('returns 404 when the link is not found', async () => {
    vi.mocked(modifyUserVocabularyTerm).mockRejectedValue(
      new VocabularyError('not_found', 'gone'),
    );

    const req = new Request('http://localhost/api/v1/domain-vocabularies/terms/missing', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validTerm),
    });
    const res = await patchTerm(req, makeParams('missing'));
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });

  it('returns 200 with the updated link on success', async () => {
    vi.mocked(modifyUserVocabularyTerm).mockResolvedValue({
      link: {
        id: 'link-1',
        termId: 'term-new',
        userId: 'user-1',
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'struct',
        canonical: 'Loan',
        localized: 'Loan',
        parentCanonical: null,
        aliases: [],
        description: null,
        source: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
      repointed: true,
      createdGlobalTerm: true,
    });

    const req = new Request('http://localhost/api/v1/domain-vocabularies/terms/link-1', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(validTerm),
    });
    const res = await patchTerm(req, makeParams('link-1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.repointed).toBe(true);
  });
});

describe('DELETE /api/v1/domain-vocabularies/terms/[id]', () => {
  it('returns 200 + success body after soft-delete', async () => {
    vi.mocked(softDeleteUserVocabularyTerm).mockResolvedValue({
      deletedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const req = new Request('http://localhost/api/v1/domain-vocabularies/terms/link-1', {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'cleanup' }),
    });
    const res = await deleteTerm(req, makeParams('link-1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.deletedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(vi.mocked(softDeleteUserVocabularyTerm)).toHaveBeenCalledWith('user-1', 'link-1', 'cleanup');
  });

  it('returns 404 when the link is not found', async () => {
    vi.mocked(softDeleteUserVocabularyTerm).mockRejectedValue(
      new VocabularyError('not_found', 'gone'),
    );

    const req = new Request('http://localhost/api/v1/domain-vocabularies/terms/missing', {
      method: 'DELETE',
    });
    const res = await deleteTerm(req, makeParams('missing'));

    expect(res.status).toBe(404);
  });
});

describe('GET /api/v1/domain-vocabularies/terms/[id]', () => {
  it('returns the term when found via the direct lookup', async () => {
    vi.mocked(getUserVocabularyTerm).mockResolvedValue({
      id: 'link-1',
      termId: 'term-1',
      userId: 'user-1',
      domain: 'finance.loan',
      locale: 'en-US',
      kind: 'struct',
      canonical: 'Loan',
      localized: 'Loan',
      parentCanonical: null,
      aliases: [],
      description: null,
      source: 'user',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await getTerm(
      new Request('http://localhost/api/v1/domain-vocabularies/terms/link-1'),
      makeParams('link-1'),
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.term.id).toBe('link-1');
    expect(vi.mocked(getUserVocabularyTerm)).toHaveBeenCalledWith('user-1', 'link-1', {
      includeDeleted: true,
    });
  });

  it('returns 404 when the link is missing', async () => {
    vi.mocked(getUserVocabularyTerm).mockResolvedValue(null);

    const res = await getTerm(
      new Request('http://localhost/api/v1/domain-vocabularies/terms/link-1'),
      makeParams('link-1'),
    );

    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/domain-vocabularies/terms/[id]/restore', () => {
  it('returns 200 + restored link on success', async () => {
    vi.mocked(restoreUserVocabularyTerm).mockResolvedValue({
      link: {
        id: 'link-1',
        termId: 'term-1',
        userId: 'user-1',
        domain: 'finance.loan',
        locale: 'en-US',
        kind: 'struct',
        canonical: 'Loan',
        localized: 'Loan',
        parentCanonical: null,
        aliases: [],
        description: null,
        source: 'user',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const req = new Request(
      'http://localhost/api/v1/domain-vocabularies/terms/link-1/restore',
      { method: 'POST' },
    );
    const res = await restoreTerm(req, makeParams('link-1'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.link.id).toBe('link-1');
    expect(body.restoredAt).toBeDefined();
  });

  it('returns 404 when the link cannot be restored', async () => {
    vi.mocked(restoreUserVocabularyTerm).mockRejectedValue(
      new VocabularyError('not_found', 'gone'),
    );

    const req = new Request(
      'http://localhost/api/v1/domain-vocabularies/terms/missing/restore',
      { method: 'POST' },
    );
    const res = await restoreTerm(req, makeParams('missing'));

    expect(res.status).toBe(404);
  });
});
