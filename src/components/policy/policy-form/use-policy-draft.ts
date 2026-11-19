'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  parseEmbeddedVocabularyField,
  storedEmbeddedVocabulary,
  type EmbeddedVocabulary,
} from '@/lib/policy-embedded-vocabulary';

/**
 * localStorage draft persistence for the policy form.
 *
 * Why client-side only: the autosave fires every second on keystroke
 * — pushing that to the server would multiply backend write volume
 * for no real benefit. localStorage is the canonical place for
 * "stuff the user typed but didn't commit." We only escalate to the
 * server on explicit Save.
 *
 * Key shape: `aster:policy-draft:${policyId ?? 'new'}`. Edit and new
 * pages have independent slots so opening /new doesn't blow away
 * an in-progress edit of an existing policy.
 *
 * Schema-versioned (`v: 3`) so future shape changes can deliberately
 * invalidate older drafts instead of mis-parsing them. v1 drafts have
 * no aliasSet and v1/v2 drafts have no embedded vocabulary; those fields
 * fall back to the server-side baseline when such a draft is restored.
 */

export interface PolicyDraftFields {
  name: string;
  description: string;
  content: string;
  isPublic: boolean;
  groupId: string | null;
  aliasSet: Record<string, string[]> | null;
  /**
   * 策略内嵌词汇（ADR 0060）。缺省视同 null（无词条）。保存时是否随请求提交由表单按与活跃版本
   * 是否不同判定（PolicySaveContext），保存页不得把它当普通字段原样展开进请求体。
   */
  embeddedVocabulary?: EmbeddedVocabulary | null;
}

interface StoredDraft extends PolicyDraftFields {
  v: 1 | 2 | 3;
  savedAt: number; // epoch ms
}

const SCHEMA_VERSION = 3;
const STORAGE_PREFIX = 'aster:policy-draft:';
// Drafts older than this are treated as stale and not surfaced to the
// user — they're more likely to be confusing than helpful (e.g. an
// old session left open in another tab months ago).
const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function storageKey(policyId: string | null): string {
  return `${STORAGE_PREFIX}${policyId ?? 'new'}`;
}

function safeRead(key: string): StoredDraft | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredDraft;
    if (parsed.v !== 1 && parsed.v !== 2 && parsed.v !== SCHEMA_VERSION) return null;
    if (Date.now() - parsed.savedAt > STALE_AFTER_MS) return null;
    return parsed.v === 1 ? { ...parsed, aliasSet: null } : parsed;
  } catch {
    return null;
  }
}

/** 草稿里的内嵌词汇按 §6.1 形状重新解析；本地存储被改坏时退回服务端基线，不让坏数据进表单。 */
function draftEmbedded(stored: unknown, baseline: EmbeddedVocabulary | null | undefined): EmbeddedVocabulary | null {
  try {
    return parseEmbeddedVocabularyField(stored);
  } catch {
    return baseline ?? null;
  }
}

function safeWrite(key: string, draft: StoredDraft): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    // Quota exceeded / private mode — silently no-op. Autosave is
    // best-effort, not a hard guarantee.
  }
}

function safeClear(key: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

export interface UsePolicyDraftOptions {
  /** Policy id when editing; null for the new-policy route. */
  policyId: string | null;
  /** Current form state — what to write. */
  fields: PolicyDraftFields;
  /** Snapshot of the server-side fields. Used to decide whether the
   *  current state is "dirty" vs. equal to what's already persisted. */
  baseline: PolicyDraftFields;
  /** Throttle interval for writes (ms). Default 1000. */
  throttleMs?: number;
  /** If true (default), skip persistence. Useful while the form is
   *  still mounting and hasn't loaded user input yet. */
  enabled?: boolean;
}

export interface UsePolicyDraftResult {
  /** True if the current `fields` differ from `baseline`. */
  isDirty: boolean;
  /** Epoch ms of the most recent autosave to localStorage. 0 if none. */
  lastSavedAt: number;
  /** A draft loaded on mount that differs from baseline, or null. */
  pendingDraft: PolicyDraftFields | null;
  /** Apply the loaded draft into the form (clears pendingDraft). */
  acceptPendingDraft: () => void;
  /** Discard the loaded draft (clears storage + pendingDraft). */
  discardPendingDraft: () => void;
  /** Wipe the saved draft. Call after a successful Save. */
  clearDraft: () => void;
}

/** Stable equality check across the draft fields. */
function draftEquals(a: PolicyDraftFields, b: PolicyDraftFields): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.content === b.content &&
    a.isPublic === b.isPublic &&
    a.groupId === b.groupId &&
    JSON.stringify(a.aliasSet ?? null) === JSON.stringify(b.aliasSet ?? null) &&
    // 规范序列化比较：词条顺序与 NFC 差异不算改动
    storedEmbeddedVocabulary(a.embeddedVocabulary) === storedEmbeddedVocabulary(b.embeddedVocabulary)
  );
}

export function usePolicyDraft({
  policyId,
  fields,
  baseline,
  throttleMs = 1000,
  enabled = true,
}: UsePolicyDraftOptions): UsePolicyDraftResult {
  const key = useMemo(() => storageKey(policyId), [policyId]);
  const [lastSavedAt, setLastSavedAt] = useState(0);

  // Pending draft is loaded in useEffect (NOT useState initializer)
  // to keep the first client render identical to the SSR output —
  // a useState initializer that reads localStorage produces
  // server/client divergence and triggers React hydration error #418.
  const [pendingDraft, setPendingDraft] = useState<PolicyDraftFields | null>(
    null,
  );
  const hasLoadedRef = useRef(false);
  useEffect(() => {
    if (hasLoadedRef.current) return;
    hasLoadedRef.current = true;
    const stored = safeRead(key);
    if (!stored) return;
    const candidate: PolicyDraftFields = {
      name: stored.name,
      description: stored.description,
      content: stored.content,
      isPublic: stored.isPublic,
      groupId: stored.groupId,
      aliasSet: stored.aliasSet ?? null,
      // v3 之前的草稿没有这个字段：按服务端基线，不把「没记录」当成「清空」
      embeddedVocabulary: stored.v === SCHEMA_VERSION
        ? draftEmbedded(stored.embeddedVocabulary, baseline.embeddedVocabulary)
        : (baseline.embeddedVocabulary ?? null),
    };
    if (!draftEquals(candidate, baseline)) {
      // 挂载时一次性把 localStorage 里的草稿读入 state（刻意避开 useState
      // 初始化器以防 hydration 错位）——从外部存储同步初值，非渲染循环。
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPendingDraft(candidate);
    }
    // baseline intentionally omitted — first mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const isDirty = useMemo(
    () => !draftEquals(fields, baseline),
    [fields, baseline],
  );

  // Throttled write loop. `fields` updates on every keystroke; the
  // timer collapses bursts so we hit localStorage at most once per
  // throttleMs window even during fast typing.
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingFieldsRef = useRef(fields);
  // ref-latch：每次渲染把最新 fields 挂到 ref，节流定时器 closure 从中读取最新
  // 快照（不进 effect deps，避免每次键入重挂定时器）。仅写入不参与渲染输出。
  // eslint-disable-next-line react-hooks/refs
  pendingFieldsRef.current = fields;

  useEffect(() => {
    if (!enabled) return;
    // Don't autosave a clean form — it would needlessly clobber a
    // legitimately-saved draft from a previous session.
    if (!isDirty) return;
    if (timerRef.current) return; // throttle window still open

    timerRef.current = setTimeout(() => {
      const snapshot = pendingFieldsRef.current;
      const now = Date.now();
      safeWrite(key, { v: SCHEMA_VERSION, savedAt: now, ...snapshot });
      setLastSavedAt(now);
      timerRef.current = null;
    }, throttleMs);
  }, [fields, isDirty, key, throttleMs, enabled]);

  // Final flush on unmount: if a throttle is still pending, write
  // immediately so the user doesn't lose the last keystrokes on a
  // navigation away.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
        const snapshot = pendingFieldsRef.current;
        safeWrite(key, {
          v: SCHEMA_VERSION,
          savedAt: Date.now(),
          ...snapshot,
        });
      }
    };
  }, [key]);

  const acceptPendingDraft = useCallback(() => {
    setPendingDraft(null);
  }, []);

  const discardPendingDraft = useCallback(() => {
    safeClear(key);
    setPendingDraft(null);
  }, [key]);

  const clearDraft = useCallback(() => {
    safeClear(key);
    setLastSavedAt(0);
  }, [key]);

  return {
    isDirty,
    lastSavedAt,
    pendingDraft,
    acceptPendingDraft,
    discardPendingDraft,
    clearDraft,
  };
}
