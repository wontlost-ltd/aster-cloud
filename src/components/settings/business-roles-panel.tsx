'use client';

/**
 * 业务角色（ADR 0042 §2.1）的编辑组件。
 *
 * BusinessRolesEditor：只读 chip + 逗号输入框编辑，团队成员行与设置页共用；
 * 保存交给调用方（团队走成员路由，个人走 /api/user/business-roles），
 * 编辑器只负责拆分输入、展示服务端归一后的结果与错误。
 * BusinessRolesPanel：设置页的个人租户卡片，包一层 Card 并接上个人路由。
 *
 * ★校验以服务端 normalizeBusinessRoles 为准，客户端只做逗号拆分与去空，
 * 避免两处规则漂移；服务端返回 invalid_business_role 时显示 labels.invalid。
 */

import { useState } from 'react';

import { Button, Card, CardBody, Input, Stack } from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';

export interface BusinessRolesEditorLabels {
  none: string;
  edit: string;
  placeholder: string;
  hint: string;
  save: string;
  saving: string;
  cancel: string;
  invalid: string;
  saveFailed: string;
}

const INVALID_CODE = 'invalid_business_role';

/** 把保存失败映射成可展示文案：词表不合法单独提示，其余用服务端消息或通用失败。 */
export async function businessRolesSaveError(res: Response, labels: BusinessRolesEditorLabels): Promise<Error> {
  const msg = extractErrorMessage(await res.json().catch(() => null));
  return new Error(msg === INVALID_CODE ? labels.invalid : msg || labels.saveFailed);
}

export function BusinessRolesEditor({
  roles,
  canEdit,
  onSave,
  labels,
}: {
  roles: string[];
  canEdit: boolean;
  /** 保存并返回服务端归一后的角色；失败时抛出可展示的 Error。 */
  onSave: (roles: string[]) => Promise<string[]>;
  labels: BusinessRolesEditorLabels;
}) {
  const [current, setCurrent] = useState(roles);
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // 父组件重新拉取（如他处并发改了角色）时，非编辑态跟随新的 props；编辑中不打断用户输入。
  // 以内容为键比较，避免父组件每次渲染新建数组导致反复同步。
  const rolesKey = roles.join('\n');
  const [syncedKey, setSyncedKey] = useState(rolesKey);
  if (draft === null && rolesKey !== syncedKey) {
    setSyncedKey(rolesKey);
    setCurrent(roles);
  }

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError('');
    try {
      const parts = draft.split(',').map((r) => r.trim()).filter((r) => r !== '');
      setCurrent(await onSave(parts));
      setDraft(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : labels.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  if (draft === null) {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        {current.length === 0 && <span className="text-xs text-fg-subtle">{labels.none}</span>}
        {current.map((role) => (
          <span key={role} className="inline-flex items-center rounded-full bg-bg-muted px-2 py-0.5 text-xs font-medium text-fg">
            {role}
          </span>
        ))}
        {canEdit && (
          <button type="button" onClick={() => setDraft(current.join(', '))} className="text-xs text-primary hover:text-primary-hover">
            {labels.edit}
          </button>
        )}
      </div>
    );
  }

  return (
    <Stack gap={1}>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={labels.placeholder}
          aria-label={labels.placeholder}
          className="min-w-[14rem] flex-1"
        />
        <Button size="sm" onClick={save} disabled={busy}>
          {busy ? labels.saving : labels.save}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setError(''); }} disabled={busy}>
          {labels.cancel}
        </Button>
      </div>
      <p className="text-xs text-fg-muted">{labels.hint}</p>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </Stack>
  );
}

export function BusinessRolesPanel({
  initialRoles,
  labels,
}: {
  initialRoles: string[];
  labels: BusinessRolesEditorLabels & { title: string; description: string };
}) {
  const saveOwn = async (roles: string[]): Promise<string[]> => {
    const res = await fetch('/api/user/business-roles', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ businessRoles: roles }),
    });
    if (!res.ok) throw await businessRolesSaveError(res, labels);
    const data = (await res.json()) as { businessRoles: string[] };
    return data.businessRoles;
  };

  return (
    <Card>
      <CardBody className="pt-6">
        <Stack gap={4}>
          <Stack gap={1}>
            <h2 className="text-base font-semibold text-fg">{labels.title}</h2>
            <p className="text-sm text-fg-muted">{labels.description}</p>
          </Stack>
          <BusinessRolesEditor roles={initialRoles} canEdit onSave={saveOwn} labels={labels} />
        </Stack>
      </CardBody>
    </Card>
  );
}
