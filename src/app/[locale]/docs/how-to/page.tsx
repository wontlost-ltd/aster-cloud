import { setRequestLocale } from 'next-intl/server';
import { redirectToFirstChild } from '@/lib/docs/section-redirect';

/**
 * /docs/how-to — 分区父路径 308 跳到首个子页，与 /docs/getting-started、/docs/guides 相同：
 * 面包屑「操作指南」及其悬停 RSC 预取不会 404。
 */
type Props = {
  params: Promise<{ locale: string }>;
};

export default async function HowToIndex({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  redirectToFirstChild(locale, 'how-to/teams');
}
