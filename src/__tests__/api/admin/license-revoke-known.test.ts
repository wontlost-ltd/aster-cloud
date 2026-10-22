import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * 许可证撤销的「未知许可证」标记（Q2）：ID 不在已签发记录中时 API 返回 knownLicense=false，
 * 演练与真实撤销都照常放行（离线签发的许可证本就不在记录里）。
 */
vi.mock('@/lib/deployment-mode', () => ({ IS_SAAS: true }));
vi.mock('@/lib/admin-auth', () => ({ requireAdmin: vi.fn(async () => ({ userId: 'admin-1' })) }));
vi.mock('@/lib/revocation-publisher', () => ({
  publishRevocationManifest: vi.fn(async () => ({ version: BigInt(7) })),
}));

const { findIssued, inserted } = vi.hoisted(() => ({
  findIssued: vi.fn(),
  inserted: [] as Array<Record<string, unknown>>,
}));
vi.mock('@/lib/prisma', () => ({
  db: {
    query: { issuedLicenses: { findFirst: findIssued } },
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserted.push(v);
        const p = Promise.resolve();
        return Object.assign(p, { onConflictDoNothing: () => Promise.resolve() });
      },
    }),
  },
  auditLogs: {},
  issuedLicenses: { licenseId: 'il.license_id' },
  revokedLicenses: {},
  revocationPublications: {},
}));

import { POST } from '@/app/api/admin/license-revoke/route';

const LIC = 'lic_E2ETEST0000000000000000AB';
const post = (body: unknown) =>
  new Request('http://localhost/api/admin/license-revoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  inserted.length = 0;
});

describe('POST /api/admin/license-revoke knownLicense', () => {
  it('★演练：未签发的 ID → knownLicense=false，且不写库', async () => {
    findIssued.mockResolvedValueOnce(undefined);
    const res = await POST(post({ licenseId: LIC, reason: 'fraud', dryRun: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ dryRun: true, licenseId: LIC, knownLicense: false });
    expect(inserted).toEqual([]);
  });

  it('演练：已签发的 ID → knownLicense=true', async () => {
    findIssued.mockResolvedValueOnce({ licenseId: LIC });
    const res = await POST(post({ licenseId: LIC, reason: 'fraud', dryRun: true }));
    expect((await res.json()).knownLicense).toBe(true);
  });

  it('真实撤销：未签发的 ID 仍然放行，响应与审计都带 knownLicense=false', async () => {
    findIssued.mockResolvedValueOnce(undefined);
    const res = await POST(post({ licenseId: LIC, reason: 'fraud' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ licenseId: LIC, publishedVersion: '7', knownLicense: false });
    const audit = inserted.find((v) => v.action === 'license.revoked');
    expect(audit?.metadata).toMatchObject({ knownLicense: false });
  });
});
