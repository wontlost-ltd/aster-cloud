#!/usr/bin/env node
import postgres from 'postgres';
import { signByokAllowlistHeaders } from '../../src/lib/api-signing.ts';
import { diffSourceHashes } from './source-hash-diff.ts';

const ENDPOINT_PATH = '/api/v1/admin/policy-versions/source-hashes';
const BATCH_SIZE = 200;

async function fetchApiRows(baseUrl, tenantId, ids, beforeId) {
  const query = new URLSearchParams({ tenantId });
  if (ids.length) query.set('ids', ids.join(','));
  if (beforeId) query.set('beforeId', beforeId);
  const signedHeaders = await signByokAllowlistHeaders('GET', ENDPOINT_PATH);
  const response = await fetch(`${baseUrl}${ENDPOINT_PATH}?${query}`, { headers: signedHeaders });
  if (!response.ok) throw new Error(`API source hash request failed: ${response.status} ${tenantId}`);
  return response.json();
}

async function fetchTenantApiRows(baseUrl, tenantId, cloudRows) {
  const apiById = new Map();
  for (let offset = 0; offset < cloudRows.length; offset += BATCH_SIZE) {
    const batch = cloudRows.slice(offset, offset + BATCH_SIZE);
    const apiRows = await fetchApiRows(baseUrl, tenantId, batch.map((row) => row.id));
    apiRows.forEach((row) => apiById.set(String(row.id), { ...row, tenantId }));
  }
  let beforeId;
  while (true) {
    const page = await fetchApiRows(baseUrl, tenantId, [], beforeId);
    page.forEach((row) => apiById.set(String(row.id), { ...row, tenantId }));
    if (page.length < BATCH_SIZE) break;
    beforeId = String(page.reduce((minimum, row) => (
      BigInt(row.id) < BigInt(minimum) ? row.id : minimum
    ), page[0].id));
  }
  return [...apiById.values()];
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  const apiBaseUrl = process.env.ASTER_POLICY_API_INTERNAL_URL
    ?? process.env.ASTER_API_BASE_URL
    ?? process.env.ASTER_API_URL;
  if (!databaseUrl || !apiBaseUrl) throw new Error('DATABASE_URL and ASTER_POLICY_API_INTERNAL_URL are required');
  const sql = postgres(databaseUrl, { max: 1, connect_timeout: 10 });
  try {
    const cloudRows = await sql`
      SELECT pv.id, pv."sourceHash" AS "sourceHash",
             COALESCE(NULLIF(p."teamId", ''), p."userId") AS "tenantId", pv.status
      FROM "PolicyVersion" pv
      JOIN "Policy" p ON p.id = pv."policyId"
      ORDER BY COALESCE(NULLIF(p."teamId", ''), p."userId"), pv.id`;
    const tenants = await sql`
      SELECT DISTINCT COALESCE(NULLIF("teamId", ''), "userId") AS "tenantId"
      FROM "Policy" ORDER BY "tenantId"`;
    const byTenant = new Map();
    for (const row of cloudRows) {
      const tenantRows = byTenant.get(row.tenantId) ?? [];
      tenantRows.push(row);
      byTenant.set(row.tenantId, tenantRows);
    }
    const mismatches = [];
    for (const { tenantId } of tenants) {
      const rows = byTenant.get(tenantId) ?? [];
      const apiRows = await fetchTenantApiRows(apiBaseUrl, tenantId, rows);
      mismatches.push(...diffSourceHashes(rows, apiRows));
    }
    const output = { mismatches };
    if (process.argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
    else if (mismatches.length) console.table(mismatches);
    else console.log('策略版本 sourceHash 全部一致');
    if (mismatches.length) process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ error: message, mismatches: [] }));
  else console.error(message);
  process.exitCode = 1;
});
