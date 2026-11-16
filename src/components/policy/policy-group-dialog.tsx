'use client';

import { useState, useEffect } from 'react';
import { X, Folder, AlertTriangle } from 'lucide-react';
import type { PolicyGroup } from './policy-group-tree';

interface PolicyGroupDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (data: { name: string; description: string; parentId: string | null }) => Promise<void>;
  onDelete?: () => Promise<void>;
  group?: PolicyGroup | null;
  parentId?: string | null;
  mode: 'create' | 'edit';
  translations: {
    createTitle: string;
    editTitle: string;
    nameLabel: string;
    namePlaceholder: string;
    descriptionLabel: string;
    descriptionPlaceholder: string;
    save: string;
    cancel: string;
    delete: string;
    deleteConfirm: string;
    deleteWarning: string;
    saving: string;
    deleting: string;
  };
}

export function PolicyGroupDialog({
  isOpen,
  onClose,
  onSave,
  onDelete,
  group,
  parentId,
  mode,
  translations: t,
}: PolicyGroupDialogProps) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [error, setError] = useState('');

  // 对话框打开时按 mode/group（外部 prop）重新播种表单——刻意的 prop→state
  // 同步，改掉会丢失「每次打开重置为最新 group」的行为。条件成立才置位。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (isOpen) {
      if (mode === 'edit' && group) {
        setName(group.name);
        setDescription(group.description || '');
      } else {
        setName('');
        setDescription('');
      }
      setError('');
      setShowDeleteConfirm(false);
    }
  }, [isOpen, mode, group]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // P1-R19: keyboard accessibility — Esc dismisses dialog (WCAG 2.1.1).
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const handleSave = async () => {
    if (!name.trim()) {
      setError(t.namePlaceholder);
      return;
    }

    setSaving(true);
    setError('');
    try {
      await onSave({
        name: name.trim(),
        description: description.trim(),
        parentId: mode === 'create' ? parentId ?? null : group?.parentId ?? null,
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!onDelete) return;

    setDeleting(true);
    setError('');
    try {
      await onDelete();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete');
    } finally {
      setDeleting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 overflow-y-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="policy-group-dialog-title"
    >
      {/* Backdrop — aria-hidden because Esc handler + close button provide keyboard close */}
      <div
        className="fixed inset-0 bg-black bg-opacity-50"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div className="relative w-full max-w-md transform overflow-hidden rounded-lg bg-bg shadow-xl transition-all">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center">
              <Folder className="w-5 h-5 text-primary mr-2" />
              <h3 id="policy-group-dialog-title" className="text-lg font-semibold text-fg">
                {mode === 'create' ? t.createTitle : t.editTitle}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1 hover:bg-bg-muted"
            >
              <X className="w-5 h-5 text-fg-muted" />
            </button>
          </div>

          {/* Content */}
          <div className="px-4 py-4">
            {error && (
              <div className="mb-4 rounded-md bg-red-50 p-3">
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}

            {showDeleteConfirm ? (
              <div className="space-y-4">
                <div className="flex items-start">
                  <AlertTriangle className="w-5 h-5 text-amber-500 mr-2 mt-0.5" />
                  <div>
                    <p className="text-sm font-medium text-fg">
                      {t.deleteConfirm}
                    </p>
                    <p className="text-sm text-fg-muted mt-1">
                      {t.deleteWarning}
                    </p>
                  </div>
                </div>
                <div className="flex justify-end space-x-3">
                  <button
                    onClick={() => setShowDeleteConfirm(false)}
                    className="px-3 py-2 text-sm font-medium text-fg bg-bg border border-border-strong rounded-md hover:bg-bg-subtle"
                    disabled={deleting}
                  >
                    {t.cancel}
                  </button>
                  <button
                    onClick={handleDelete}
                    className="px-3 py-2 text-sm font-medium text-white bg-red-600 rounded-md hover:bg-red-700 disabled:opacity-50"
                    disabled={deleting}
                  >
                    {deleting ? t.deleting : t.delete}
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div>
                  <label htmlFor="group-name" className="block text-sm font-medium text-fg mb-1">
                    {t.nameLabel}
                  </label>
                  <input
                    id="group-name"
                    name="group-name"
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t.namePlaceholder}
                    className="w-full rounded-md border border-border-strong px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                    autoFocus
                  />
                </div>

                <div>
                  <label htmlFor="group-description" className="block text-sm font-medium text-fg mb-1">
                    {t.descriptionLabel}
                  </label>
                  <textarea
                    id="group-description"
                    name="group-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t.descriptionPlaceholder}
                    rows={3}
                    className="w-full rounded-md border border-border-strong px-3 py-2 text-sm focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
            )}
          </div>

          {/* Footer */}
          {!showDeleteConfirm && (
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <div>
                {mode === 'edit' && onDelete && (
                  <button
                    onClick={() => setShowDeleteConfirm(true)}
                    className="text-sm font-medium text-red-600 hover:text-red-700"
                  >
                    {t.delete}
                  </button>
                )}
              </div>
              <div className="flex space-x-3">
                <button
                  onClick={onClose}
                  className="px-3 py-2 text-sm font-medium text-fg bg-bg border border-border-strong rounded-md hover:bg-bg-subtle"
                  disabled={saving}
                >
                  {t.cancel}
                </button>
                <button
                  onClick={handleSave}
                  className="px-3 py-2 text-sm font-medium text-primary-fg bg-primary rounded-md hover:bg-primary-hover disabled:opacity-50"
                  disabled={saving}
                >
                  {saving ? t.saving : t.save}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
