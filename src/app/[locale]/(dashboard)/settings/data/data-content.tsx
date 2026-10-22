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

/** 抹除接口里 AI 工作台部分的结果（F23）；工作台未部署时不出现。 */
type WorkspaceErase =
  | { error: string }
  | { deletedConversations: number; tenantHold: boolean; held: string[] };

/** 工作台抹除后需要常驻提示的情形：失败、或有线程因法律保留未删除。 */
type EraseNotice = { kind: 'failed' } | { kind: 'held'; count: number } | { kind: 'tenantHold' };

function toEraseNotice(ws: WorkspaceErase | undefined): EraseNotice | null {
  if (!ws) return null;
  if ('error' in ws) return { kind: 'failed' };
  if (ws.tenantHold) return { kind: 'tenantHold' };
  return ws.held.length > 0 ? { kind: 'held', count: ws.held.length } : null;
}

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
  // 下载成功但未能包含 AI 工作台数据（F23）：文件照常下载，同时常驻提示。
  const [workspaceExportMissing, setWorkspaceExportMissing] = useState(false);
  // 下载成功但审计原文无法解密（密钥缺失或被轮换）：其余记录照常下载，同时常驻提示。
  const [auditContentMissing, setAuditContentMissing] = useState(false);
  const [eraseNotice, setEraseNotice] = useState<EraseNotice | null>(null);

  const downloadJson = async () => {
    setIsDownloading(true);
    setDownloadError(null);
    setWorkspaceExportMissing(false);
    setAuditContentMissing(false);
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
      const text = await res.text();
      const parsed = (() => {
        try {
          return JSON.parse(text) as {
            aiWorkspace?: { error?: unknown };
            auditContent?: { error?: unknown };
          };
        } catch {
          return null;
        }
      })();
      setWorkspaceExportMissing(typeof parsed?.aiWorkspace?.error === 'string');
      setAuditContentMissing(typeof parsed?.auditContent?.error === 'string');
      const blob = new Blob([text], { type: 'application/json' });
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
    setEraseNotice(null);
    try {
      const res = await fetch('/api/user/ai-data', { method: 'DELETE' });
      const data = (await res.json().catch(() => ({}))) as {
        records_cleared?: number;
        error?: string;
        aiWorkspace?: WorkspaceErase;
      };
      if (!res.ok) {
        toast.error(t('deleteCard.failure', { error: extractErrorMessage(data) || res.status }));
        return;
      }
      toast.success(
        t('deleteCard.success', { count: data.records_cleared ?? 0 }),
      );
      setEraseNotice(toEraseNotice(data.aiWorkspace));
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
            {auditContentMissing && (
              <Alert variant="warning" className="mt-4">
                <AlertDescription>{t('auditContentUnavailable')}</AlertDescription>
              </Alert>
            )}
            {workspaceExportMissing && (
              <Alert variant="warning" className="mt-4">
                <AlertDescription>{t('workspaceExportUnavailable')}</AlertDescription>
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
            {eraseNotice && (
              <Alert variant="warning" className="mt-4">
                <AlertDescription>
                  {eraseNotice.kind === 'failed' && t('deleteCard.workspaceFailed')}
                  {eraseNotice.kind === 'held' &&
                    t('deleteCard.workspaceHeld', { count: eraseNotice.count })}
                  {eraseNotice.kind === 'tenantHold' && t('deleteCard.workspaceTenantHold')}
                </AlertDescription>
              </Alert>
            )}
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
