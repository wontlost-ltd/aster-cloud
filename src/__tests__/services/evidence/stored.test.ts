// 已持久化证据导出读取侧单测（ADR 0041 §5）：v1/v2 按 schemaVersion 收窄，未知版本与非证据行不可读。

import { describe, it, expect } from 'vitest';
import { readStoredEvidenceExport, summarizeManifest, summarizeStoredExport } from '@/services/evidence/stored';
import { serializeBundle } from '@/services/evidence/bundle';
import type { EvidenceManifestV1 } from '@/services/evidence/types';

const V1: EvidenceManifestV1 = {
  kind: 'evidence-export', schemaVersion: '1', generatedAt: '2026-07-01T00:00:00.000Z', policy: { scope: 'all' },
  range: { start: null, end: null }, totals: { count: 3 },
  decisionTally: { approved: 3, denied: 0, indeterminate: 0, error: 0, unknown: 0 },
  canonicalizationVersion: 'v1', bundleHash: 'a'.repeat(64),
  notes: { legacyRowsWithoutHashes: 0, verification: 'v1 recipe' },
};

const V2_MANIFEST = {
  ...V1, schemaVersion: '2', totals: { count: 5 }, bundleHash: 'b'.repeat(64),
  receiptSource: { kind: 'aster-api-hash-chain', verifier: 'GET /api/v1/audit/receipts' },
  agentTally: {}, reviewerTally: { 'guard-approval': 0, 'policy-proof': 0, 'version-approval': 0 }, legacyEntries: 0,
  notes: { legacyRowsWithoutHashes: 0, receiptsUnavailable: 1, receiptsMissing: 0, verification: 'v2 recipe' },
};

const V3_MANIFEST = { ...V2_MANIFEST, schemaVersion: '3', totals: { count: 1 }, bundleHash: 'h' };

const stored = (manifest: unknown) => ({ kind: 'evidence-export', manifest, bundle: { manifest, entries: [] }, format: 'json' });

describe('readStoredEvidenceExport', () => {
  it('★v1/v2/v3 行均可读，manifest 原样返回', () => {
    expect(readStoredEvidenceExport(stored(V1))?.manifest).toBe(V1);
    expect(readStoredEvidenceExport(stored(V2_MANIFEST))?.manifest).toBe(V2_MANIFEST);
    expect(readStoredEvidenceExport(stored(V3_MANIFEST))?.manifest).toBe(V3_MANIFEST);
  });

  it('★未知 schemaVersion / 缺 manifest / 非证据行 / null ⇒ null', () => {
    expect(readStoredEvidenceExport(stored({ ...V1, schemaVersion: '4' }))).toBeNull();
    expect(readStoredEvidenceExport({ kind: 'evidence-export' })).toBeNull();
    expect(readStoredEvidenceExport({ ...stored(V1), kind: 'compliance' })).toBeNull();
    expect(readStoredEvidenceExport(null)).toBeNull();
  });

  it('v1 包经 serializeBundle 原样序列化（不升级、不重算）', () => {
    const s = readStoredEvidenceExport(stored(V1))!;
    expect(JSON.parse(serializeBundle(s.bundle, 'json'))).toEqual({ manifest: V1, entries: [] });
  });
});

describe('summarizeManifest / summarizeStoredExport', () => {
  it('★按版本取条数与 bundleHash', () => {
    expect(summarizeManifest(V1)).toEqual({ schemaVersion: '1', count: 3, bundleHash: 'a'.repeat(64) });
    expect(summarizeStoredExport(stored(V3_MANIFEST))).toEqual({ schemaVersion: '3', count: 1, bundleHash: 'h' });
    expect(summarizeStoredExport(stored(V2_MANIFEST))).toEqual({ schemaVersion: '2', count: 5, bundleHash: 'b'.repeat(64) });
  });

  it('生成中（data=null）或不可读 ⇒ null', () => {
    expect(summarizeStoredExport(null)).toBeNull();
    expect(summarizeStoredExport(stored({ ...V1, schemaVersion: 'x' }))).toBeNull();
  });
});
