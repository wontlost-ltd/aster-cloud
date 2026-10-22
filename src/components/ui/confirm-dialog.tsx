'use client';

/**
 * Aster-cloud ConfirmDialog 包装。
 *
 * 设计系统的 ConfirmDialog 与语言无关，未传按钮文案时默认英文 'Confirm' / 'Cancel'；
 * 调用方大多只传确认文案，于是取消按钮在 zh/de/hi 页面上露出英文。这里用 common 命名空间
 * 的本地化文案补齐缺省值，调用方显式传入的文案仍然优先。
 */
import {
  ConfirmDialog as DesignSystemConfirmDialog,
  type ConfirmDialogProps,
} from '@aster-cloud/ui';
import { useTranslations } from 'next-intl';

export type { ConfirmDialogProps };

export function ConfirmDialog({ confirmLabel, cancelLabel, ...props }: ConfirmDialogProps) {
  const t = useTranslations('common');
  return (
    <DesignSystemConfirmDialog
      {...props}
      confirmLabel={confirmLabel ?? t('confirm')}
      cancelLabel={cancelLabel ?? t('cancel')}
    />
  );
}
