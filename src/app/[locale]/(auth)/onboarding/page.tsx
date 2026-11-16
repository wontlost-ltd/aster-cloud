import { redirect } from 'next/navigation';
import { getSession } from '@/lib/auth';

/**
 * 原注册后的两步偏好向导已并入仪表盘的上手清单（#796）：行业与目标改为清单里可选的「偏好」条目，就地填写。
 *
 * <p>路由保留为跳转：注册流程中途的回跳地址、书签或旧邮件里的链接仍会落到这里。
 * 已完成或跳过旧向导的用户直接进仪表盘，不会被要求补填任何东西。
 * 未登录访问时先去登录（#589），登录后同样回到仪表盘。
 */
export default async function OnboardingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login?callbackUrl=${encodeURIComponent(`/${locale}/dashboard`)}`);
  }
  redirect(`/${locale}/dashboard`);
}
