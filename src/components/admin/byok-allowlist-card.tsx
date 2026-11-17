'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Card, CardBody, Input, Stack } from '@/components/ui';

/**
 * BYOK endpoint allowlist 管理卡片（平台管理员）。
 *
 * 控制 aster-api 允许 BYOK 自定义 Provider URL 指向哪些 host（出站 SSRF 边界）。
 * 真相源 = 后端 /api/admin/byok-allowlist（GET）。add/remove 即时生效（后端 Redis SET +
 * pub/sub 广播，跨所有 replica，零 CI/零重启）。
 *
 * 来源标注：builtin（官方 openai/anthropic）+ env（k3s bootstrap）只读；dynamic（管理员动态
 * 添加）可删。add 的 host 由 aster-api SsrfGuard 校验（私网/元数据 deny），非法 host 返回 400。
 */
interface EndpointView {
  host: string;
  port: number;
  pathPrefix: string;
  source: 'builtin' | 'env' | 'dynamic';
  tenantScope: string | null;
  removable: boolean;
}

export function ByokAllowlistCard() {
  const t = useTranslations('byokAllowlistSettings');
  const [endpoints, setEndpoints] = useState<EndpointView[]>([]);
  const [loading, setLoading] = useState(true);
  const [newHost, setNewHost] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/byok-allowlist', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { endpoints?: EndpointView[] };
      setEndpoints(data.endpoints ?? []);
      setError('');
    } catch {
      setError(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    // 挂载时异步拉取 allowlist，setState 发生在 fetch 完成后的回调中（非渲染期同步），属合法的数据加载副作用。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const mutate = async (action: 'add' | 'remove', host: string) => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch('/api/admin/byok-allowlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, host }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { message?: string } | null;
        setError(body?.message ?? t('mutateFailed'));
        return;
      }
      if (action === 'add') setNewHost('');
      await load();
    } catch {
      setError(t('mutateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const sourceBadge = (source: EndpointView['source']) => {
    const variant =
      source === 'dynamic' ? 'success' : source === 'builtin' ? 'primary' : 'neutral';
    return <Badge variant={variant} className="shrink-0">{t(`source.${source}`)}</Badge>;
  };

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <Stack gap={1}>
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
              {t('title')}
            </h2>
            <p className="text-sm text-fg-muted">{t('description')}</p>
          </Stack>

          {/* 添加 host */}
          <Stack direction="row" gap={2} align="center">
            <Input
              value={newHost}
              onChange={(e) => setNewHost(e.target.value)}
              placeholder={t('addPlaceholder')}
              disabled={busy}
              className="min-w-0 flex-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && newHost.trim()) void mutate('add', newHost.trim());
              }}
            />
            <Button
              onClick={() => newHost.trim() && void mutate('add', newHost.trim())}
              disabled={busy || !newHost.trim()}
            >
              {t('add')}
            </Button>
          </Stack>

          {error && <p className="text-sm text-danger">{error}</p>}

          {/* 列表 */}
          {loading ? (
            <p className="text-sm text-fg-muted">{t('loading')}</p>
          ) : (
            <ul className="flex flex-col gap-2" aria-label={t('title')}>
              {endpoints.map((e) => (
                <li
                  key={`${e.source}:${e.host}:${e.port}:${e.pathPrefix}`}
                  className="flex items-center justify-between gap-3"
                >
                  {/* 长主机名没有断点：任意处折行而不是截断，完整可见、可选中复制 */}
                  <Stack direction="row" gap={2} align="center" className="min-w-0 flex-1">
                    <code className="min-w-0 text-sm font-medium text-fg [overflow-wrap:anywhere]">
                      {e.host}
                      {e.port !== 443 ? `:${e.port}` : ''}
                      {e.pathPrefix}
                    </code>
                    {sourceBadge(e.source)}
                  </Stack>
                  {e.removable && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void mutate('remove', e.host)}
                      disabled={busy}
                    >
                      {t('remove')}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
