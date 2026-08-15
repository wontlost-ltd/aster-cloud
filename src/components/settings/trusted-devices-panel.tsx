'use client';

/**
 * 已信任设备列表 + 移除（issue #400）。
 *
 * <p>为什么这个面板必须存在：用户勾了「记住该设备」之后，那台设备在 30 天内
 * 只凭密码即可登录。没有这个列表，用户**看不到自己授权过哪些设备**，
 * 也无法在设备丢失/借出后收回授权——只能清 cookie（对已丢失的设备做不到）
 * 或干等过期。
 *
 * <p>★列表只展示粗粒度标签（"Chrome on macOS"）+ 时间，不展示任何 token 派生值。
 */

import { useCallback, useEffect, useState } from 'react';

import { Button, Card, CardBody, Stack } from '@/components/ui';

interface TrustedDevice {
  id: string;
  label: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  expires: string;
}

export interface TrustedDevicesLabels {
  title: string;
  description: string;
  empty: string;
  unknownDevice: string;
  lastUsed: string;
  never: string;
  expires: string;
  remove: string;
  removing: string;
  loadFailed: string;
  removeFailed: string;
}

export function TrustedDevicesPanel({ labels: t }: { labels: TrustedDevicesLabels }) {
  const [devices, setDevices] = useState<TrustedDevice[] | null>(null);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);

  /**
   * 纯取数——**不碰 state**，便于在 effect 里安全调用（见下方 useEffect 注释）。
   */
  const loadDevices = useCallback(async (): Promise<
    { ok: true; devices: TrustedDevice[] } | { ok: false }
  > => {
    try {
      const res = await fetch('/api/user/trusted-devices');
      if (!res.ok) return { ok: false };
      const data = (await res.json()) as { devices: TrustedDevice[] };
      return { ok: true, devices: data.devices };
    } catch {
      return { ok: false };
    }
  }, []);

  /** 取数并落 state——供事件处理器（移除后刷新）调用，不在 effect 体内同步调用。 */
  const refresh = useCallback(async () => {
    const res = await loadDevices();
    if (res.ok) {
      setDevices(res.devices);
      setError('');
    } else {
      setDevices([]);
      setError(t.loadFailed);
    }
  }, [loadDevices, t.loadFailed]);

  useEffect(() => {
    // ★不在 effect 体内同步调用会 setState 的函数（react-hooks 规则）：
    //   那会触发级联渲染。挂到微任务里，并用 cancelled 标志避免卸载后 setState。
    let cancelled = false;
    void (async () => {
      const res = await loadDevices();
      if (cancelled) return;
      if (res.ok) {
        setDevices(res.devices);
        setError('');
      } else {
        setDevices([]);
        setError(t.loadFailed);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [t.loadFailed]);

  const remove = async (id: string) => {
    setBusyId(id);
    setError('');
    try {
      const res = await fetch('/api/user/trusted-devices', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) {
        setError(t.removeFailed);
        return;
      }
      // 重新拉取而非本地剔除：以服务端为准，避免"看起来删了实际没删"。
      await refresh();
    } catch {
      setError(t.removeFailed);
    } finally {
      setBusyId(null);
    }
  };

  const fmt = (iso: string | null) =>
    iso ? new Date(iso).toLocaleDateString() : t.never;

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <div>
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
              {t.title}
            </h2>
            <p className="mt-1 text-sm text-fg-muted">{t.description}</p>
          </div>

          {error && <p className="text-sm text-rose-600">{error}</p>}

          {devices === null ? null : devices.length === 0 ? (
            <p className="text-sm text-fg-muted">{t.empty}</p>
          ) : (
            <Stack gap={3}>
              {devices.map((d) => (
                <div
                  key={d.id}
                  className="flex items-center justify-between gap-4 rounded border border-border px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-fg">
                      {d.label ?? t.unknownDevice}
                    </p>
                    <p className="text-xs text-fg-muted">
                      {t.lastUsed}: {fmt(d.lastUsedAt)} · {t.expires}: {fmt(d.expires)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busyId === d.id}
                    onClick={() => void remove(d.id)}
                  >
                    {busyId === d.id ? t.removing : t.remove}
                  </Button>
                </div>
              ))}
            </Stack>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
