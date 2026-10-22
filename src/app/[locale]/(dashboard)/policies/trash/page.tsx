import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TrashContent } from './trash-content';

export default async function PolicyTrashPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const session = await getSession();
  if (!session?.user?.id) {
    redirect(`/${locale}/login`);
  }

  const t = await getTranslations('policies');
  const tCommon = await getTranslations('common');

  const translations = {
    trash: {
      title: t('trash.title'),
      description: t('trash.description'),
      backToPolicies: t('trash.backToPolicies'),
      empty: t('trash.empty'),
      emptyTrash: t('trash.emptyTrash'),
      confirmEmptyTrash: t('trash.confirmEmptyTrash'),
      restore: t('trash.restore'),
      permanentDelete: t('trash.permanentDelete'),
      // 保留 {name} 占位符，由客户端按被删除的策略名替换
      confirmPermanentDelete: t.raw('trash.confirmPermanentDeleteNamed') as string,
      deletedAt: t('trash.deletedAt'),
      expiresAt: t('trash.expiresAt'),
      reason: t('trash.reason'),
      noReason: t('trash.noReason'),
      restoreSuccess: t('trash.restoreSuccess'),
      restoreWithNewName: t('trash.restoreWithNewName'),
      deleteSuccess: t('trash.deleteSuccess'),
      emptySuccess: t('trash.emptySuccess'),
      loadError: t('trash.loadError'),
      actionError: t('trash.actionError'),
      itemCount: t('trash.itemCount'),
      daysRemaining: t('trash.daysRemaining'),
      loading: tCommon('loading'),
    },
  };

  return <TrashContent translations={translations} locale={locale} />;
}
