'use client';

/**
 * 邮箱验证面板。
 *
 * <p>补上此前完全缺失的一环：`ai-quota.ts` 的 L0.5 闸门要求 Free 档
 * `emailVerified` 才解锁 AI，但全仓没有任何路径能把该字段置位——
 * 凭账号密码注册的用户被永久锁死。本面板 + `/api/user/send-verification`
 * + `/api/user/verify-email` 一起构成完整流程。
 *
 * <p>三态：加载中 / 已验证（只读展示）/ 未验证（可发信）。
 * 发信成功后停留在「已发送」提示，不自动轮询——用户点邮件链接后
 * 落到 /verify-email，回到本页会重新拉取状态。
 */

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, CardBody, Stack } from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';

export interface EmailVerificationLabels {
  title: string;
  description: string;
  statusVerified: string;
  statusUnverified: string;
  send: string;
  sending: string;
  sent: string;
  resend: string;
}

export function EmailVerificationPanel({ labels }: { labels: EmailVerificationLabels }) {
  const [loading, setLoading] = useState(true);
  const [email, setEmail] = useState('');
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/user/send-verification');
      if (!res.ok) return;
      const data = (await res.json()) as { email?: string; verified?: boolean };
      setEmail(data.email ?? '');
      setVerified(!!data.verified);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const send = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/user/send-verification', { method: 'POST' });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(extractErrorMessage(data) || 'Failed to send');
      }
      // 服务端发现已验证时返回 alreadyVerified，直接切到已验证态而非显示「已发送」。
      if ((data as { alreadyVerified?: boolean } | null)?.alreadyVerified) {
        setVerified(true);
      } else {
        setSent(true);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send');
    } finally {
      setBusy(false);
    }
  }, []);

  // ★id 在加载态也要挂上：AI 卡片的「Verify now →」锚到 #email-verification，
  //   若只在加载完成后才渲染该 id，跳转时锚点还不存在，浏览器会停在页首。
  if (loading) {
    return <div id="email-verification" className="h-28 animate-pulse rounded-lg bg-bg-muted" />;
  }

  return (
    <Card id="email-verification">
      <CardBody className="pt-6">
        <Stack gap={4}>
          <Stack gap={1}>
            <h2 className="text-base font-semibold text-fg">{labels.title}</h2>
            <p className="text-sm text-fg-muted">{labels.description}</p>
          </Stack>

          <Stack direction="row" justify="between" align="center" gap={4}>
            <Stack gap={1}>
              <span className="text-sm text-fg">{email}</span>
              <span
                className={
                  verified
                    ? 'text-xs font-medium text-green-700'
                    : 'text-xs font-medium text-amber-700'
                }
              >
                {verified ? labels.statusVerified : labels.statusUnverified}
              </span>
            </Stack>

            {!verified && (
              <Button onClick={send} disabled={busy} variant="secondary">
                {busy ? labels.sending : sent ? labels.resend : labels.send}
              </Button>
            )}
          </Stack>

          {sent && !verified && (
            <p className="text-xs text-green-700">{labels.sent}</p>
          )}
          {error && <p className="text-xs text-red-600">{error}</p>}
        </Stack>
      </CardBody>
    </Card>
  );
}
