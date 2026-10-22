'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { extractErrorMessage } from '@/lib/api/error-envelope';
import {
  Alert,
  AlertDescription,
  Breadcrumbs,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  CardDescription,
  ConfirmDialog,
  Container,
  PageHeader,
  Stack,
  toast,
} from '@/components/ui';

/**
 * Client island for /settings/data.
 *
 * Two cards: download (GET /api/user/ai-data-export, Article 15)
 * and erase (DELETE /api/user/ai-data, Article 17). The two paths
 * are separated on purpose — putting export on the same route as
 * erase would let a curl GET accidentally trip the erasure handler
 * via method-confusion bugs. Two paths, two methods, two intents.
 */
export function DataContent() {
  const t = useTranslations('settings.dataPage');
  const tSettings = useTranslations('settings');
  const tCommon = useTranslations('common');
  const [confirmErase, setConfirmErase] = useState(false);
  const [isErasing, setIsErasing] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  // 导出失败用按钮下方的常驻提示，而不是几秒即逝的 toast（生产上用户反馈「点了没反应」）。
  // 只显示本地化文案 + requestId（便于客服关联日志），不渲染服务端原文。
  const [downloadError, setDownloadError] = useState<{ requestId: string | null } | null>(null);

  const downloadJson = async () => {
    setIsDownloading(true);
    setDownloadError(null);
    try {
      // GDPR Article 15 export endpoint. The sibling /ai-data path
      // is DELETE-only — GET against it returns 405.
      const res = await fetch('/api/user/ai-data-export');
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as {
          error?: { requestId?: unknown } | string;
        };
        const requestId =
          (typeof data.error === 'object' && typeof data.error?.requestId === 'string'
            ? data.error.requestId
            : null) ?? res.headers.get('x-request-id');
        setDownloadError({ requestId });
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      a.download = `aster-ai-data-${stamp}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch {
      // 网络层失败（离线等）：同样给本地化提示，不展示异常原文。
      setDownloadError({ requestId: null });
    } finally {
      setIsDownloading(false);
    }
  };

  const eraseContent = async () => {
    setIsErasing(true);
    try {
      const res = await fetch('/api/user/ai-data', { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as {
        records_cleared?: number;
        error?: string;
      };
      if (!res.ok) {
        toast.error(t('deleteCard.failure', { error: extractErrorMessage(data) || res.status }));
        return;
      }
      toast.success(
        t('deleteCard.success', { count: data.records_cleared ?? 0 }),
      );
      setConfirmErase(false);
    } finally {
      setIsErasing(false);
    }
  };

  return (
    <Container size="xl" className="py-6 sm:py-10">
      <Stack gap={6}>
        <PageHeader
          breadcrumbs={
            <Breadcrumbs
              items={[
                { label: tSettings('title'), href: '/settings' },
                { label: t('breadcrumb') },
              ]}
            />
          }
          title={t('title')}
          subtitle={t('subtitle')}
        />

        <Card>
          <CardHeader>
            <CardTitle>{t('downloadCard.title')}</CardTitle>
            <CardDescription>{t('downloadCard.body')}</CardDescription>
          </CardHeader>
          <CardBody>
            <Button
              variant="primary"
              onClick={downloadJson}
              disabled={isDownloading}
            >
              {t('downloadCard.action')}
            </Button>
            {downloadError && (
              <Alert variant="danger" className="mt-4">
                <AlertDescription>
                  {t('downloadUnavailable')}
                  {downloadError.requestId && (
                    <span className="mt-1 block font-mono text-xs opacity-80">
                      {tCommon('errorId')}: {downloadError.requestId}
                    </span>
                  )}
                </AlertDescription>
              </Alert>
            )}
          </CardBody>
        </Card>

        <Card className="border-danger/40">
          <CardHeader>
            <CardTitle className="text-danger">
              {t('deleteCard.title')}
            </CardTitle>
            <CardDescription>{t('deleteCard.body')}</CardDescription>
          </CardHeader>
          <CardBody>
            <Button
              variant="destructive"
              onClick={() => setConfirmErase(true)}
            >
              {t('deleteCard.action')}
            </Button>
          </CardBody>
        </Card>
      </Stack>

      <ConfirmDialog
        isOpen={confirmErase}
        title={t('deleteCard.confirmTitle')}
        // The count is server-known, so we pass `count: -1` here as a
        // placeholder — the success toast uses the real count.
        description={t('deleteCard.confirmBody', { count: 0 })}
        confirmLabel={t('deleteCard.confirmAction')}
        cancelLabel={t('deleteCard.confirmCancel')}
        variant="danger"
        isLoading={isErasing}
        onConfirm={eraseContent}
        onCancel={() => !isErasing && setConfirmErase(false)}
      />
    </Container>
  );
}
