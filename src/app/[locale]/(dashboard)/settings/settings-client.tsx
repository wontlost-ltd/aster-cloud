/**
 * Client islands for the Settings page.
 *
 * The page itself is a Server Component (settings/page.tsx) so the
 * profile card no longer flashes "Not set" while waiting for
 * useSession() on the client. Everything that genuinely needs the
 * browser — cookie I/O, signOut(), router.refresh() — lives in this
 * file as small isolated islands:
 *
 *   - LocaleDetectionToggle: writes a cookie and refreshes the RSC
 *     tree so middleware picks the new value up on the next request.
 *   - SignOutButton: calls next-auth's signOut() with a locale-aware
 *     callback URL.
 *   - DeleteAccountButton + DeleteAccountDialog: confirmation flow
 *     for the destructive account-delete action.
 *
 * Splitting them this way keeps the dashboard layout's session lookup
 * on the server (where it belongs) and stops re-running the whole
 * page's render tree on the client for cosmetic interactions.
 */
'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signOut } from 'next-auth/react';
import { ConfirmDialog } from '@/components/ui';
import { Alert, AlertDescription, Button, cn } from '@/components/ui';
import { extractErrorMessage } from '@/lib/api/error-envelope';
import { useAssistant } from '@/components/assistant/assistant-context';
import { useAiInlineCompletion } from '@/lib/preferences/ai-inline-completion';

const LOCALE_DETECTION_COOKIE = 'aster-locale-detection';

function setCookie(name: string, value: string, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${value}; expires=${expires}; path=/; SameSite=Lax`;
}

/* ------------------------------------------------------------------ */
/* LocaleDetectionToggle                                               */
/* ------------------------------------------------------------------ */

export function LocaleDetectionToggle({
  initialChecked,
  ariaLabel,
  enabledHint,
  disabledHint,
}: {
  initialChecked: boolean;
  ariaLabel: string;
  enabledHint: string;
  disabledHint: string;
}) {
  // Local state is seeded from the cookie value read on the server,
  // so the toggle never flickers from "off" to "on" after mount.
  const [checked, setChecked] = useState(initialChecked);
  const router = useRouter();

  const handleToggle = () => {
    const next = !checked;
    setChecked(next);
    setCookie(LOCALE_DETECTION_COOKIE, String(next));
    // RSC re-render so middleware reads the updated cookie on the next
    // request. Keeps client state + scroll position intact.
    router.refresh();
  };

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        onClick={handleToggle}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
          'transition-colors duration-fast ease-standard',
          'focus-visible:outline-none focus-visible:shadow-ring',
          checked ? 'bg-primary' : 'bg-bg-muted',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none inline-block size-5 transform rounded-full bg-bg shadow ring-0',
            'transition-transform duration-fast ease-standard',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
      {/* Hint paragraph is sibling so the toggle row stays tight. The
          parent server card supplies the row layout. */}
      <p className="text-xs text-fg-subtle" data-locale-detection-hint>
        {checked ? enabledHint : disabledHint}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* AssistantToggle                                                     */
/* ------------------------------------------------------------------ */

/**
 * 站内助手开关。
 *
 * <p>与 {@link LocaleDetectionToggle} 的差别：那个存 cookie（中间件要在服务端读），
 * 助手是纯客户端 UI，状态存 localStorage，故这里直接读写
 * {@link useAssistant}，无需 router.refresh()。
 *
 * <p><b>这是唯一的重新激活入口</b>——面板上的「关闭」只是收起，
 * 真正停用后必须回到这里打开（见 assistant-context 的设计说明）。
 */
export function AssistantToggle({
  ariaLabel,
  enabledHint,
  disabledHint,
}: {
  ariaLabel: string;
  enabledHint: string;
  disabledHint: string;
}) {
  const assistant = useAssistant();
  // Provider 缺失（理论上不会——挂在 locale layout）时不渲染半死的开关。
  if (!assistant) return null;
  const checked = assistant.enabled;

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        // hydrating 期间禁用：此刻 checked 还是默认值，未读到 localStorage，
        // 点下去会把用户真实设置覆盖掉。
        disabled={assistant.hydrating}
        onClick={() => assistant.setEnabled(!checked)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
          'transition-colors duration-fast ease-standard',
          'focus-visible:outline-none focus-visible:shadow-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-bg-muted',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none inline-block size-5 transform rounded-full bg-bg shadow ring-0',
            'transition-transform duration-fast ease-standard',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
      <p className="text-xs text-fg-subtle" data-assistant-hint>
        {checked ? enabledHint : disabledHint}
      </p>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* SignOutButton                                                       */
/* ------------------------------------------------------------------ */

export function SignOutButton({
  signOutLabel,
  signingOutLabel,
  callbackUrl,
}: {
  signOutLabel: string;
  signingOutLabel: string;
  callbackUrl: string;
}) {
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  return (
    <Button
      type="button"
      variant="secondary"
      onClick={async () => {
        setIsLoggingOut(true);
        await signOut({ callbackUrl });
      }}
      disabled={isLoggingOut}
    >
      {isLoggingOut ? signingOutLabel : signOutLabel}
    </Button>
  );
}

/* ------------------------------------------------------------------ */
/* DeleteAccountFlow                                                   */
/* ------------------------------------------------------------------ */

export function DeleteAccountFlow({
  triggerLabel,
  callbackUrl,
  labels,
}: {
  triggerLabel: string;
  callbackUrl: string;
  labels: {
    confirmTitle: string;
    confirmMessage: string;
    confirmItem1: string;
    confirmItem2: string;
    confirmItem3: string;
    confirmDelete: string;
    cancel: string;
    deleting: string;
  };
}) {
  const [open, setOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const response = await fetch('/api/user/delete', { method: 'DELETE' });
      if (!response.ok) {
        const data = await response.json();
        throw new Error(extractErrorMessage(data) || 'Failed to delete account');
      }
      await signOut({ callbackUrl });
    } catch (error) {
      setDeleteError(
        error instanceof Error ? error.message : 'Failed to delete account',
      );
      setIsDeleting(false);
    }
  };

  return (
    <>
      <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
        {triggerLabel}
      </Button>
      <ConfirmDialog
        isOpen={open}
        onCancel={() => !isDeleting && setOpen(false)}
        onConfirm={handleDelete}
        title={labels.confirmTitle}
        description={
          <div className="space-y-3">
            <p>{labels.confirmMessage}</p>
            <ul className="list-inside list-disc space-y-1 text-sm text-fg-muted">
              <li>{labels.confirmItem1}</li>
              <li>{labels.confirmItem2}</li>
              <li>{labels.confirmItem3}</li>
            </ul>
            {deleteError && (
              <Alert variant="danger">
                <AlertDescription>{deleteError}</AlertDescription>
              </Alert>
            )}
          </div>
        }
        confirmLabel={isDeleting ? labels.deleting : labels.confirmDelete}
        cancelLabel={labels.cancel}
        variant="danger"
        isLoading={isDeleting}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* AiInlineCompletionToggle                                            */
/* ------------------------------------------------------------------ */

/**
 * 策略编辑器 AI 行内补全开关。
 *
 * <p>与编辑器状态栏上的开关读写同一份本地偏好（见 lib/preferences/ai-inline-completion），
 * 任意一处切换，另一处立即同步（含其他标签页）。
 */
export function AiInlineCompletionToggle({
  ariaLabel,
  enabledHint,
  disabledHint,
}: {
  ariaLabel: string;
  enabledHint: string;
  disabledHint: string;
}) {
  const { value: checked, hydrating, setValue } = useAiInlineCompletion();

  return (
    <>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        // 读到本地偏好前禁用：此刻 checked 是默认值，点下去会覆盖用户真实设置。
        disabled={hydrating}
        onClick={() => setValue(!checked)}
        data-testid="settings-ai-completion-toggle"
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
          'transition-colors duration-fast ease-standard',
          'focus-visible:outline-none focus-visible:shadow-ring',
          'disabled:cursor-not-allowed disabled:opacity-50',
          checked ? 'bg-primary' : 'bg-bg-muted',
        )}
      >
        <span
          aria-hidden
          className={cn(
            'pointer-events-none inline-block size-5 transform rounded-full bg-bg shadow ring-0',
            'transition-transform duration-fast ease-standard',
            checked ? 'translate-x-5' : 'translate-x-0',
          )}
        />
      </button>
      <p className="text-xs text-fg-subtle" data-ai-completion-hint>
        {checked ? enabledHint : disabledHint}
      </p>
    </>
  );
}
