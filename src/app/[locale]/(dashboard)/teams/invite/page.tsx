import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';
import { AcceptInviteContent } from './invite-content';

interface PageProps {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/**
 * 接受团队邀请。未登录时先去登录，并把带 token 的原地址作为 callbackUrl 带上——
 * 邀请邮件里的链接在登录后仍能直接接受（#589：此前未登录也渲染工作台外壳，点接受才 401）。
 */
export default async function AcceptInvitePage({ params, searchParams }: PageProps) {
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    const token = (await searchParams).token;
    const query = typeof token === 'string' && token ? `?token=${encodeURIComponent(token)}` : '';
    redirect(`/${locale}/login?callbackUrl=${encodeURIComponent(`/${locale}/teams/invite${query}`)}`);
  }
  return <AcceptInviteContent />;
}
