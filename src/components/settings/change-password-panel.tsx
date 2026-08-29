'use client';

/**
 * 设置页的「修改密码」面板。
 *
 * <p>后端 `/api/user/change-password` 早已完整（校验当前密码、拒绝
 * OAuth-only 账号、改密后吊销全部可信设备），此前**只在 onboarding
 * 强制改密流程里有 UI**——登录用户没有自愿改密的入口。本面板补上。
 *
 * <p>★OAuth-only 账号：后端返回 400 "No password set on this account"。
 * 这不是错误操作，而是该账号本就没有密码。故把这一条单独识别出来，
 * 引导去「忘记密码」设置一个，而不是甩一句红色报错。
 *
 * <p>★改密成功会吊销全部可信设备（后端行为），故成功提示里必须说明
 * 这一点——否则用户下次登录被要求二次验证会以为是故障。
 */

import { useCallback, useState } from 'react';

import { Button, Card, CardBody, Input, Label, Stack } from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';

export interface ChangePasswordLabels {
  title: string;
  description: string;
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
  submit: string;
  submitting: string;
  success: string;
  mismatch: string;
  tooShort: string;
  noPassword: string;
  forgotPasswordLink: string;
}

/**
 * 后端对 OAuth-only 账号的标识。
 *
 * ★优先读结构化 `code`，字符串仅作兜底：只匹配 message 会在后端改文案时
 * 静默失效（退化成一句无意义的红色报错）。code 是稳定契约。
 */
const NO_PASSWORD_CODE = 'NO_PASSWORD';
const NO_PASSWORD_ERROR = 'No password set on this account';

export function ChangePasswordPanel({
  labels,
  forgotPasswordHref,
}: {
  labels: ChangePasswordLabels;
  forgotPasswordHref: string;
}) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [noPassword, setNoPassword] = useState(false);
  const [done, setDone] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError('');
      setDone(false);

      if (next.length < 8) {
        setError(labels.tooShort);
        return;
      }
      if (next !== confirm) {
        setError(labels.mismatch);
        return;
      }

      setBusy(true);
      try {
        const res = await fetch('/api/user/change-password', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: current, newPassword: next }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          const msg = extractErrorMessage(data) || 'Failed to change password';
          const code = (data as { code?: unknown } | null)?.code;
          if (code === NO_PASSWORD_CODE || msg === NO_PASSWORD_ERROR) {
            setNoPassword(true);
            return;
          }
          throw new Error(msg);
        }
        setDone(true);
        setCurrent('');
        setNext('');
        setConfirm('');
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to change password');
      } finally {
        setBusy(false);
      }
    },
    [current, next, confirm, labels],
  );

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <Stack gap={1}>
            <h2 className="text-base font-semibold text-fg">{labels.title}</h2>
            <p className="text-sm text-fg-muted">{labels.description}</p>
          </Stack>

          {noPassword ? (
            <Stack gap={2}>
              <p className="text-sm text-fg-muted">{labels.noPassword}</p>
              <a
                href={forgotPasswordHref}
                className="text-sm font-medium text-primary hover:underline"
              >
                {labels.forgotPasswordLink}
              </a>
            </Stack>
          ) : (
            <form onSubmit={submit}>
              <Stack gap={3}>
                <Stack gap={1}>
                  <Label htmlFor="current-password">{labels.currentPassword}</Label>
                  <Input
                    id="current-password"
                    type="password"
                    autoComplete="current-password"
                    required
                    value={current}
                    onChange={(e) => setCurrent(e.target.value)}
                  />
                </Stack>
                <Stack gap={1}>
                  <Label htmlFor="new-password">{labels.newPassword}</Label>
                  <Input
                    id="new-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={next}
                    onChange={(e) => setNext(e.target.value)}
                  />
                </Stack>
                <Stack gap={1}>
                  <Label htmlFor="confirm-password">{labels.confirmPassword}</Label>
                  <Input
                    id="confirm-password"
                    type="password"
                    autoComplete="new-password"
                    required
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Stack>

                <Stack direction="row" gap={3} align="center">
                  <Button type="submit" disabled={busy}>
                    {busy ? labels.submitting : labels.submit}
                  </Button>
                  {done && <span className="text-xs text-green-700">{labels.success}</span>}
                </Stack>

                {error && <p className="text-xs text-red-600">{error}</p>}
              </Stack>
            </form>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
