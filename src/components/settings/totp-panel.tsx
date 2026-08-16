'use client';

/**
 * 验证器 App（TOTP）绑定面板 —— issue #400 第二步。
 *
 * <p>三个状态：
 * <ol>
 *   <li><b>未绑定</b>：一个「开始绑定」按钮</li>
 *   <li><b>绑定中</b>：二维码 + 手动输入用的密钥 + 确认输入框</li>
 *   <li><b>已绑定</b>：显示剩余恢复码数量 + 解绑（需输码）</li>
 * </ol>
 *
 * <p>★恢复码只在确认成功那一刻显示一次，之后服务端只留 hash。
 * 界面必须明确告知"现在就抄下来"，否则用户会关掉页面然后永远失去它们。
 *
 * <p>★二维码是服务端生成的**内联 SVG**（无外部请求、无 canvas），
 * 用 dangerouslySetInnerHTML 注入。内容来自我们自己的 `renderQrSvg`，
 * 不含任何用户可控的原始文本——URI 里的 email 已由 QR 编码器转成图形模块。
 */

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, CardBody, Input, Label, Stack } from '@/components/ui';

export interface TotpLabels {
  title: string;
  description: string;
  statusEnabled: string;
  statusDisabled: string;
  remainingCodes: string;
  start: string;
  starting: string;
  scanHint: string;
  manualKeyLabel: string;
  confirmLabel: string;
  confirmHint: string;
  confirm: string;
  confirming: string;
  cancel: string;
  recoveryTitle: string;
  recoveryWarning: string;
  recoveryDone: string;
  disable: string;
  disabling: string;
  disableHint: string;
  loadFailed: string;
  confirmFailed: string;
  disableFailed: string;
  alreadyEnabled: string;
}

interface Status {
  enabled: boolean;
  remainingRecoveryCodes: number;
}

interface Enrollment {
  secret: string;
  qrSvg: string;
}

export function TotpPanel({ labels: t }: { labels: TotpLabels }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [token, setToken] = useState('');
  const [disableToken, setDisableToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/totp');
      if (!res.ok) throw new Error(String(res.status));
      setStatus(await res.json());
    } catch {
      setError(t.loadFailed);
    }
  }, [t.loadFailed]);

  // ★用 void + 异步边界避免"在 effect 里同步 setState"——
  //   load() 内部的 setState 发生在 await 之后，不在同一渲染周期。
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (alive) await load();
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  async function start() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/totp', { method: 'POST' });
      if (res.status === 409) {
        setError(t.alreadyEnabled);
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setEnrollment({ secret: data.secret, qrSvg: data.qrSvg });
    } catch {
      setError(t.loadFailed);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/totp', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        setError(t.confirmFailed);
        return;
      }
      const data = await res.json();
      // ★这是恢复码唯一一次出现的地方。
      setRecoveryCodes(data.recoveryCodes);
      setEnrollment(null);
      setToken('');
      await load();
    } catch {
      setError(t.confirmFailed);
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/auth/totp', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: disableToken }),
      });
      if (!res.ok) {
        setError(t.disableFailed);
        return;
      }
      setDisableToken('');
      await load();
    } catch {
      setError(t.disableFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardBody>
        <Stack gap={4}>
          <div>
            <h2 className="text-lg font-semibold">{t.title}</h2>
            <p className="text-sm text-fg-muted">{t.description}</p>
          </div>

          {error && <p className="text-sm text-danger">{error}</p>}

          {/* 恢复码：确认成功后一次性展示 */}
          {recoveryCodes && (
            <Stack gap={2}>
              <h3 className="font-medium">{t.recoveryTitle}</h3>
              <p className="text-sm text-warning">{t.recoveryWarning}</p>
              <ul className="grid grid-cols-2 gap-1 font-mono text-sm">
                {recoveryCodes.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              <Button onClick={() => setRecoveryCodes(null)}>{t.recoveryDone}</Button>
            </Stack>
          )}

          {/* 绑定中：二维码 + 确认 */}
          {enrollment && !recoveryCodes && (
            <Stack gap={3}>
              <p className="text-sm">{t.scanHint}</p>
              <div
                className="w-fit rounded bg-white p-2"
                // 内容来自服务端 renderQrSvg，非用户可控原始文本。
                dangerouslySetInnerHTML={{ __html: enrollment.qrSvg }}
              />
              <div>
                <Label>{t.manualKeyLabel}</Label>
                <code className="block break-all font-mono text-sm">
                  {enrollment.secret}
                </code>
              </div>
              <Stack gap={2}>
                <Label htmlFor="totpConfirm">{t.confirmLabel}</Label>
                <Input
                  id="totpConfirm"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={6}
                  value={token}
                  onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
                />
                <p className="text-xs text-fg-muted">{t.confirmHint}</p>
              </Stack>
              <Stack direction="row" gap={2}>
                <Button onClick={confirm} disabled={busy || token.length !== 6}>
                  {busy ? t.confirming : t.confirm}
                </Button>
                <Button variant="secondary" onClick={() => setEnrollment(null)} disabled={busy}>
                  {t.cancel}
                </Button>
              </Stack>
            </Stack>
          )}

          {/* 已绑定 */}
          {status?.enabled && !enrollment && (
            <Stack gap={3}>
              <p className="text-sm font-medium">{t.statusEnabled}</p>
              <p className="text-sm text-fg-muted">
                {t.remainingCodes.replace(
                  '{count}',
                  String(status.remainingRecoveryCodes),
                )}
              </p>
              <Stack gap={2}>
                <Label htmlFor="totpDisable">{t.disableHint}</Label>
                <Input
                  id="totpDisable"
                  maxLength={9}
                  value={disableToken}
                  onChange={(e) => setDisableToken(e.target.value)}
                />
                <Button
                  variant="destructive"
                  onClick={disable}
                  disabled={busy || disableToken.length < 6}
                >
                  {busy ? t.disabling : t.disable}
                </Button>
              </Stack>
            </Stack>
          )}

          {/* 未绑定 */}
          {status && !status.enabled && !enrollment && !recoveryCodes && (
            <Stack gap={2}>
              <p className="text-sm text-fg-muted">{t.statusDisabled}</p>
              <Button onClick={start} disabled={busy}>
                {busy ? t.starting : t.start}
              </Button>
            </Stack>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
