// 已持久化证据导出的读取侧（ADR 0041 §5）。
//
// ComplianceReport.data 里可能是 v1 或 v2 包：写入只产 v2，读取按 schemaVersion 收窄，
// 未知版本一律当作不可读（返回 null），绝不按 v2 形状强行解释。纯函数，客户端与服务端共用。

import type {
  EvidenceExportRequest,
  StoredEvidenceBundle,
  StoredEvidenceManifest,
} from './types';

/** ComplianceReport.data 中证据导出的存储形态（v1 / v2）。 */
export interface StoredEvidenceExport {
  kind: 'evidence-export';
  manifest: StoredEvidenceManifest;
  bundle: StoredEvidenceBundle;
  format: EvidenceExportRequest['format'];
}

const KNOWN_SCHEMA_VERSIONS: ReadonlySet<unknown> = new Set<StoredEvidenceManifest['schemaVersion']>(['1', '2']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** data 列 → 已知版本的存储形态；非证据导出行、尚未生成完（无 manifest）或未知 schemaVersion → null。 */
export function readStoredEvidenceExport(data: unknown): StoredEvidenceExport | null {
  if (!isRecord(data) || data.kind !== 'evidence-export') return null;
  const manifest = data.manifest;
  if (!isRecord(manifest) || !KNOWN_SCHEMA_VERSIONS.has(manifest.schemaVersion)) return null;
  return data as unknown as StoredEvidenceExport;
}

/** 历史列表摘要（v1/v2 共有字段）。 */
export interface StoredEvidenceSummary {
  schemaVersion: StoredEvidenceManifest['schemaVersion'];
  count: number;
  bundleHash: string;
}

export function summarizeManifest(manifest: StoredEvidenceManifest): StoredEvidenceSummary {
  switch (manifest.schemaVersion) {
    case '1':
      return { schemaVersion: '1', count: manifest.totals.count, bundleHash: manifest.bundleHash };
    case '2':
      return { schemaVersion: '2', count: manifest.totals.count, bundleHash: manifest.bundleHash };
  }
}

/** 列表行 data → 摘要；不可读时 null（UI 显示占位）。 */
export function summarizeStoredExport(data: unknown): StoredEvidenceSummary | null {
  const stored = readStoredEvidenceExport(data);
  return stored ? summarizeManifest(stored.manifest) : null;
}
