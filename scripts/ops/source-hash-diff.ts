export interface SourceHashRow {
  id: string | number;
  sourceHash: string | null;
  tenantId?: string;
  status?: string;
}

export interface SourceHashMismatch {
  type: 'cloud_missing_api' | 'hash_mismatch' | 'api_missing_cloud';
  id: string;
  tenantId?: string;
  cloudSourceHash?: string | null;
  apiSourceHash?: string | null;
}

/** 比较两端同租户策略版本哈希，结果按类型与版本 id 稳定排序。 */
export function diffSourceHashes(
  cloudRows: SourceHashRow[],
  apiRows: SourceHashRow[],
): SourceHashMismatch[] {
  const cloud = new Map(cloudRows.map((row) => [String(row.id), row]));
  const api = new Map(apiRows.map((row) => [String(row.id), row]));
  const mismatches: SourceHashMismatch[] = [];
  for (const [id, row] of cloud) {
    const counterpart = api.get(id);
    if (!counterpart) {
      mismatches.push({ type: 'cloud_missing_api', id, ...(row.tenantId ? { tenantId: row.tenantId } : {}), cloudSourceHash: row.sourceHash });
    } else if (row.sourceHash !== counterpart.sourceHash) {
      mismatches.push({ type: 'hash_mismatch', id, ...(row.tenantId ? { tenantId: row.tenantId } : {}), cloudSourceHash: row.sourceHash, apiSourceHash: counterpart.sourceHash });
    }
  }
  for (const [id, row] of api) {
    if (!cloud.has(id)) mismatches.push({ type: 'api_missing_cloud', id, ...(row.tenantId ? { tenantId: row.tenantId } : {}), apiSourceHash: row.sourceHash });
  }
  return mismatches.sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));
}
