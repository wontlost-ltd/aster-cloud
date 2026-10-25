import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

/**
 * 团队详情及其成员/策略/设置子页的登录守卫。
 * 子页面是客户端组件，无法在服务端判定会话，故在段布局上统一守卫：未登录跳转登录页并带回原地址
 * （#589：此前未登录也渲染工作台外壳，只显示「Unauthorized」或可提交的表单）。
 */
export default async function TeamDetailLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string, teamId: string }> }) {
  const { locale, teamId } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login?callbackUrl=${encodeURIComponent(`/${locale}/teams/${teamId}`)}`);
  }
  return children;
}
