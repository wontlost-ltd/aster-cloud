'use client';

import { useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, Button, Card, CardBody, Input, Stack, buttonVariants, cn } from '@/components/ui';

interface GrantRow {
  userId: string;
  email: string | null;
  name: string | null;
  granted: boolean;
}

const PAGE_SIZE = 10;

export function StructuralAliasGrantsCard() {
  const t = useTranslations('admin.structuralAliasGrants');
  const [rows, setRows] = useState<GrantRow[]>([]);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    void (async () => {
      const res = await fetch('/api/admin/structural-alias-grants');
      if (!res.ok) return;
      const data = (await res.json()) as { users: GrantRow[] };
      setRows(data.users);
    })();
  }, []);

  // 搜索（email / name / userId，大小写不敏感）+ 分页均为客户端：卡片已 fetch 全量用户，
  // 且它是 admin 概览里的自包含卡片，不走 URL-driven 分页（避免污染 admin 页 URL / 与其它卡片冲突）。
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        (r.email ?? '').toLowerCase().includes(q) ||
        (r.name ?? '').toLowerCase().includes(q) ||
        r.userId.toLowerCase().includes(q),
    );
  }, [rows, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // 搜索变化时回到第 1 页（否则可能停在超出结果集的空页）——按依赖键(query)变化重置分页状态，属合法的状态重置。
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setPage(1), [query]);

  const toggle = async (row: GrantRow) => {
    const next = !row.granted;
    setBusy((m) => ({ ...m, [row.userId]: true }));
    setRows((items) => items.map((item) => (
      item.userId === row.userId ? { ...item, granted: next } : item
    )));
    try {
      const res = await fetch('/api/admin/structural-alias-grants', {
        method: next ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: row.userId }),
      });
      if (!res.ok) {
        setRows((items) => items.map((item) => (
          item.userId === row.userId ? { ...item, granted: row.granted } : item
        )));
      }
    } catch {
      setRows((items) => items.map((item) => (
        item.userId === row.userId ? { ...item, granted: row.granted } : item
      )));
    } finally {
      setBusy((m) => ({ ...m, [row.userId]: false }));
    }
  };

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <div>
            <h2 className="font-display text-xl font-semibold tracking-tight text-fg">
              {t('title')}
            </h2>
            <p className="mt-1 text-sm text-fg-muted">{t('description')}</p>
          </div>

          {/* 搜索（email / name / userId） */}
          <Input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('searchPlaceholder')}
            aria-label={t('searchPlaceholder')}
          />

          {/* 固定高度容器：列表区始终占 4 条记录的高度（18rem），**卡片高度不随搜索结果多少
              伸缩**——0/1/几条 或空结果都保持同高，多于 4 条内部滚动。实测每行 66px（p-3 + 两行
              文本）+ gap-2(8px)：4 行 = 4×66+3×8 = 288px = 18rem。 */}
          <div className="h-[18rem] overflow-y-auto pr-1">
            {filtered.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <p className="text-center text-sm text-fg-muted">{t('noResults')}</p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {pageRows.map((row) => {
                const busyNow = busy[row.userId] ?? false;
                return (
                  <li
                    key={row.userId}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-bg-subtle p-3"
                  >
                    <Stack gap={1} className="min-w-0 flex-1">
                      {/* 长邮箱 / 用户 ID 没有断点：允许任意处折行而不是截断，窄屏下完整可见、可选中复制 */}
                      <Stack direction="row" gap={2} align="center">
                        <p className="min-w-0 text-sm font-medium text-fg [overflow-wrap:anywhere]">
                          {row.email ?? row.name ?? row.userId}
                        </p>
                        <Badge variant={row.granted ? 'success' : 'neutral'} className="shrink-0">
                          {row.granted ? t('granted') : t('notGranted')}
                        </Badge>
                      </Stack>
                      <p className="text-xs text-fg-muted [overflow-wrap:anywhere]">{row.userId}</p>
                    </Stack>
                    <button
                      type="button"
                      onClick={() => toggle(row)}
                      disabled={busyNow}
                      className={cn(
                        buttonVariants({
                          variant: row.granted ? 'secondary' : 'primary',
                          size: 'sm',
                        }),
                        'disabled:opacity-50',
                      )}
                    >
                      {busyNow ? t('saving') : row.granted ? t('revoke') : t('grant')}
                    </button>
                  </li>
                );
                })}
              </ul>
            )}
          </div>

          {/* 分页控件（客户端，多于 1 页才显示） */}
          {totalPages > 1 && (
            <Stack direction="row" gap={2} align="center" className="justify-between">
              <p className="text-xs text-fg-muted">
                {t('pageOf', { page: currentPage, totalPages, total: filtered.length })}
              </p>
              <Stack direction="row" gap={2} align="center">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage <= 1}
                >
                  {t('prev')}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage >= totalPages}
                >
                  {t('next')}
                </Button>
              </Stack>
            </Stack>
          )}
        </Stack>
      </CardBody>
    </Card>
  );
}
