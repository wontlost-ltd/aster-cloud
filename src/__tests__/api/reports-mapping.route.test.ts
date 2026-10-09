// 法规对照接口（ADR 0045 §5）：v4 返回注册表驱动的对照，v1–v3 如实返回 null，越权/不存在统一 404。
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/auth', () => ({ auth: vi.fn() }));
vi.mock('@/lib/evidence', () => ({ getEvidenceExport: vi.fn() }));

import { GET } from '@/app/api/reports/[id]/mapping/route';
import { auth } from '@/auth';
import { getEvidenceExport } from '@/lib/evidence';

const mapping = { registryVersion: '1.0.0', frameworks: [] };

function call(id: string) {
  const req = new Request(`http://localhost/api/reports/${id}/mapping`) as unknown as Parameters<typeof GET>[0];
  return GET(req, { params: Promise.resolve({ id }) });
}

function row(manifest: Record<string, unknown>) {
  return { id: 'r1', status: 'completed', data: { kind: 'evidence-export', manifest, bundle: {}, format: 'json' } } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({ user: { id: 'user-1' } } as never);
});

describe('GET /api/reports/[id]/mapping', () => {
  it('未登录 → 401', async () => {
    vi.mocked(auth).mockResolvedValue(null as never);
    expect((await call('r1')).status).toBe(401);
  });

  it('v4 报告 → 返回 regulatoryMapping', async () => {
    vi.mocked(getEvidenceExport).mockResolvedValue(row({ schemaVersion: '4', regulatoryMapping: mapping }));
    const r = await call('r1');
    expect(r.status).toBe(200);
    expect((await r.json()).mapping.registryVersion).toBe('1.0.0');
    expect(getEvidenceExport).toHaveBeenCalledWith('user-1', 'r1');
  });

  it('v3 报告 → { mapping: null }', async () => {
    vi.mocked(getEvidenceExport).mockResolvedValue(row({ schemaVersion: '3', regulatoryMapping: { framework: 'EU_AI_ACT' } }));
    const r = await call('r1');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ mapping: null });
  });

  it('他人或不存在的 id → 404 not_found', async () => {
    vi.mocked(getEvidenceExport).mockResolvedValue(undefined as never);
    const r = await call('other');
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: 'not_found' });
  });
});
