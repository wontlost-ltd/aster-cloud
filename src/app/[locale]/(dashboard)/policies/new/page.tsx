import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { NewPolicyContent } from './new-policy-content';
import { getStructuralAliasGrant } from '@/lib/structural-alias-grants';
import { resolveEntitlementForRequest } from '@/lib/capabilities/resolve';
import { toEditorAuthoringProps } from '@/lib/capabilities/editor-props';
import { isNameEscapeEnabled } from '@/lib/platform-settings';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

import { buildPoliciesNewCallback } from './build-callback';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('policies', 'newPolicy');

export default async function NewPolicyPage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const session = await getSession();
  const sp = await searchParams;

  if (!session?.user?.id) {
    const callback = buildPoliciesNewCallback(locale, sp);
    redirect(`/${locale}/login?callbackUrl=${encodeURIComponent(callback)}`);
  }

  const allowStructuralAliases = await getStructuralAliasGrant(session.user.id);
  // 新建团队策略时 teamId 来自查询串，决定按谁的套餐判定；重复出现时取第一个，
  // 与客户端 new-policy-content 的 searchParams.get('teamId') 口径一致
  const rawTeamId = Array.isArray(sp.teamId) ? sp.teamId[0] : sp.teamId;
  const teamId = rawTeamId ? rawTeamId : null;
  const structuredAuthoring = toEditorAuthoringProps(
    await resolveEntitlementForRequest(session.user.id, 'structured_authoring', { teamId }),
  );
  // 编辑器名字转义（ADR 0058 修订 3）：平台开关，缺行 / 读库失败一律关闭
  const nameEscape = await isNameEscapeEnabled();

  return (
    <NewPolicyContent
      locale={locale}
      allowStructuralAliases={allowStructuralAliases}
      structuredAuthoring={structuredAuthoring}
      nameEscape={nameEscape}
    />
  );
}
