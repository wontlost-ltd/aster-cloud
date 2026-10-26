/**
 * GET /api/v1/domain-vocabularies/bulk/jobs（#605：此前只有 POST，GET 返回 405，刷新后找不回任务）
 * GET /api/v1/domain-vocabularies/version（#608：跨 isolate 的失效信号）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/auth', () => ({ getSession: vi.fn() }));

vi.mock('@/lib/domain-vocabulary-jobs', async (orig) => {
  const original = (await orig()) as Record<string, unknown>;
  return { ...original, listBulkJobs: vi.fn() };
});

vi.mock('@/lib/domain-vocabulary', async (orig) => {
  const original = (await orig()) as Record<string, unknown>;
  return { ...original, getUserVocabularyVersion: vi.fn() };
});

import { GET as listJobs } from '@/app/api/v1/domain-vocabularies/bulk/jobs/route';
import { GET as getVersion } from '@/app/api/v1/domain-vocabularies/version/route';
import { getSession } from '@/lib/auth';
import { listBulkJobs } from '@/lib/domain-vocabulary-jobs';
import { getUserVocabularyVersion } from '@/lib/domain-vocabulary';

function mockSession(userId: string | null) {
  vi.mocked(getSession).mockResolvedValue(
    (userId ? { user: { id: userId } } : null) as unknown as Awaited<ReturnType<typeof getSession>>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSession('user-1');
});

describe('GET /bulk/jobs', () => {
  it('未登录返回 401', async () => {
    mockSession(null);
    const res = await listJobs(new Request('http://localhost/api/v1/domain-vocabularies/bulk/jobs'));
    expect(res.status).toBe(401);
    expect(listBulkJobs).not.toHaveBeenCalled();
  });

  it('?status=active 只查 queued/running，并按调用者隔离', async () => {
    vi.mocked(listBulkJobs).mockResolvedValue([
      { id: 'job-1', status: 'queued' } as Awaited<ReturnType<typeof listBulkJobs>>[number],
    ]);
    const res = await listJobs(
      new Request('http://localhost/api/v1/domain-vocabularies/bulk/jobs?status=active&limit=5'),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ jobs: [{ id: 'job-1', status: 'queued' }] });
    expect(listBulkJobs).toHaveBeenCalledWith('user-1', { activeOnly: true, limit: 5 });
  });

  it('非法 limit 回落到默认值', async () => {
    vi.mocked(listBulkJobs).mockResolvedValue([]);
    await listJobs(new Request('http://localhost/api/v1/domain-vocabularies/bulk/jobs?limit=abc'));
    expect(listBulkJobs).toHaveBeenCalledWith('user-1', { activeOnly: false, limit: 20 });
  });
});

describe('GET /version', () => {
  it('未登录返回 401', async () => {
    mockSession(null);
    const res = await getVersion(new Request('http://localhost/api/v1/domain-vocabularies/version'));
    expect(res.status).toBe(401);
  });

  it('按 domain/locale 范围返回版本，且禁止缓存', async () => {
    vi.mocked(getUserVocabularyVersion).mockResolvedValue('3-1793000000000');
    const res = await getVersion(
      new Request('http://localhost/api/v1/domain-vocabularies/version?domain=finance&locale=de'),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    await expect(res.json()).resolves.toEqual({ version: '3-1793000000000' });
    expect(getUserVocabularyVersion).toHaveBeenCalledWith('user-1', { domain: 'finance', locale: 'de' });
  });

  it('查询失败返回 500 且不泄露内部错误', async () => {
    vi.mocked(getUserVocabularyVersion).mockRejectedValue(new Error('connection refused 10.0.0.1'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await getVersion(new Request('http://localhost/api/v1/domain-vocabularies/version'));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain('10.0.0.1');
  });
});
