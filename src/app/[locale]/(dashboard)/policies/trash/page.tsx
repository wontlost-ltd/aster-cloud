import { getSession } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TrashContent } from './trash-content';
import { localizedTitle } from '@/lib/page-metadata';

export const generateMetadata = localizedTitle('policies.trash', 'title');

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
      confirmPermanentDelete: t('trash.confirmPermanentDelete'),
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
    },
  };

  return <TrashContent translations={translations} locale={locale} />;
}
