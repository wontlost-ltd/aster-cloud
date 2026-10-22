// /admin/license-revoke — SaaS-side license revocation console。
//
// 设计意图：
//   - SaaS-only defense-in-depth：sidebar 隐藏只是 UX，页面本身仍 notFound
//   - 首屏由 server component 直接读 DB 拿初始状态，client component 只处理交互
//   - 写操作后用 router.refresh() 回到 server truth，避免客户端维护影子状态

import { notFound } from 'next/navigation';
import { setRequestLocale } from 'next-intl/server';
import { desc } from 'drizzle-orm';
import { isAdminFromSession } from '@/lib/admin-auth';
import { IS_SAAS } from '@/lib/deployment-mode';
import {
  db,
  revokedLicenses,
  revocationPublications,
} from '@/lib/prisma';
import {
  RevocationContent,
  type CurrentPublication,
  type RevokedLicense,
} from './revocation-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('admin.nav', 'licenseRevoke');

type Props = {
  params: Promise<{ locale: string }>;
};

export const dynamic = 'force-dynamic';

const UNDO_WINDOW_MS = 6 * 60 * 60 * 1000;

export default async function LicenseRevokePage({ params }: Props) {
  if (!IS_SAAS) {
    notFound();
  }

  const admin = await isAdminFromSession();
  if (!admin) {
    notFound();
  }

  const { locale } = await params;
  setRequestLocale(locale);

  const [revoked, currentPublication] = await Promise.all([
    fetchRevokedLicenses(),
    fetchCurrentPublication(),
  ]);

  return (
    <RevocationContent
      initialRevoked={revoked}
      currentPublication={currentPublication}
    />
  );
}

async function fetchRevokedLicenses(): Promise<RevokedLicense[]> {
  const rows = await db.query.revokedLicenses.findMany({
    orderBy: [desc(revokedLicenses.revokedAt)],
  });
  return rows.map((row) => ({
    licenseId: row.licenseId,
    reason: row.reason as RevokedLicense['reason'],
    revokedAt: row.revokedAt.toISOString(),
    revokedBy: row.revokedBy,
    notes: row.notes ?? undefined,
    customerRef: row.customerRef ?? undefined,
    undoExpiresAt: new Date(
      row.revokedAt.getTime() + UNDO_WINDOW_MS,
    ).toISOString(),
  }));
}

async function fetchCurrentPublication(): Promise<CurrentPublication | null> {
  const row = await db.query.revocationPublications.findFirst({
    orderBy: [desc(revocationPublications.version)],
  });
  if (!row) return null;
  return {
    version: row.version.toString(),
    publishedAt: row.publishedAt.toISOString(),
    validUntil: row.validUntil.toISOString(),
    revokedCount: row.revokedCount,
  };
}
