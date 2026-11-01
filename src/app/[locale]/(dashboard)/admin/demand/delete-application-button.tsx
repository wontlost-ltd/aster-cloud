'use client';

/** 管理端删除单条试点申请（确认后调用 DELETE，再刷新服务端渲染的列表）。 */
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui';

export function DeleteApplicationButton({
  id,
  labels,
}: {
  id: string;
  labels: { delete: string; confirm: string; failed: string };
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (!window.confirm(labels.confirm)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/admin/pilot-applications/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) throw new Error(String(res.status));
      router.refresh();
    } catch {
      window.alert(labels.failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClick}>
      {labels.delete}
    </Button>
  );
}
