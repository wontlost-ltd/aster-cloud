/**
 * 信贷试点端到端跑通脚本（ADR 0044 §5）：执行四组申请 → 信贷员审批 → What-If 批量 →
 * 导出证据包 → 核对 Article 14 九款状态。
 *
 *   BASE_CLOUD=http://localhost:3100 CP_API_KEY=... NEXTAUTH_SECRET=... npx tsx scripts/run-credit-pilot.ts
 * CP_ORIGIN 可覆盖 cookie 请求的 Origin（默认 BASE_CLOUD）。
 * 退出码：0 全部通过；1 任一步骤失败；2 条款状态与期望不符。仅用于本地栈。
 */
import { writeFileSync } from 'node:fs';
import { CREDIT_PILOT, PILOT_APPLICANTS, type PilotApplicant } from '../src/config/credit-pilot-source';
import { EXPECTED_CLAUSE_STATUS, diffClauses, type ClauseMappingLike } from './lib/credit-pilot-expectations';
import { SESSION_COOKIE_NAME, sessionCookie } from './lib/session-cookie';

const BASE = process.env.BASE_CLOUD || 'http://localhost:3100';
// CSRF 网关只认 allow-list 内的 Origin（CSRF_ALLOWED_ORIGINS / NEXT_PUBLIC_APP_URL），可与 BASE_CLOUD 不同
const ORIGIN = process.env.CP_ORIGIN || BASE;
const OUT = process.env.OUT || './credit-pilot-bundle.json';
const POLICY = CREDIT_PILOT.policyId;
const POLL_INTERVAL_MS = 2_000;
const POLL_LIMIT_MS = 120_000;

type Who = 'ownerId' | 'officerId' | 'analystId';
const PLANS: Record<Who, string> = { ownerId: 'team', officerId: 'pro', analystId: 'pro' };

type Auth = Record<string, string>;
interface Execution { outcome: string; correlationId: string }
interface InboxItem { id: string; evidenceCorrelationId: string | null }

function log(step: number, msg: string): void {
  console.log(`[pilot] step ${step} ${msg}`);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`缺少环境变量 ${name}`);
  return v;
}

// 统一请求：非预期状态码即抛错，带上响应正文便于定位
async function call<T>(auth: Auth, method: string, path: string, expect: number, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { ...auth };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (res.status !== expect) throw new Error(`${method} ${path} → ${res.status}（期望 ${expect}）：${text.slice(0, 500)}`);
  return (text ? JSON.parse(text) : null) as T;
}

// 会话密钥只解析一次，缺失时同时点名两个变量
let cachedSecret: string | undefined;
function secret(): string {
  cachedSecret ??= process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
  if (!cachedSecret) throw new Error('缺少环境变量 AUTH_SECRET / NEXTAUTH_SECRET');
  return cachedSecret;
}

async function cookieAuth(who: Who): Promise<Auth> {
  const id = CREDIT_PILOT[who];
  const value = await sessionCookie({ id, email: `${id}@stack.test`, plan: PLANS[who] }, secret());
  // cookie 会话的变更请求须带 Origin 才能过 CSRF 网关
  return { Cookie: `${SESSION_COOKIE_NAME}=${value}`, Origin: ORIGIN };
}

async function execute(auth: Auth, applicant: PilotApplicant): Promise<Execution> {
  const body = { input: { applicant }, agent: { provider: 'pilot', model: 'credit-pilot-script' } };
  const res = await call<{ data: { outcome?: string; metadata?: { outcome?: string; evidenceCorrelationId?: string } } }>(
    auth, 'POST', `/api/v1/policies/${POLICY}/execute`, 200, body,
  );
  const outcome = res.data.metadata?.outcome ?? res.data.outcome;
  const correlationId = res.data.metadata?.evidenceCorrelationId;
  if (!outcome || !correlationId) throw new Error(`执行结果缺 outcome/evidenceCorrelationId：${JSON.stringify(res.data)}`);
  return { outcome, correlationId };
}

// 第 1 步：以 cp-owner 的 Bearer key 让四组申请人各执行一次，结论须恰好覆盖四种（属主执行才可被 What-If 回放）
async function stepExecute(): Promise<Record<keyof typeof PILOT_APPLICANTS, Execution>> {
  const auth = { Authorization: `Bearer ${need('CP_API_KEY')}` };
  const want = { allow: 'ALLOW', deny: 'DENY', requireApproval: 'REQUIRE_APPROVAL', escalate: 'ESCALATE' } as const;
  const results = {} as Record<keyof typeof PILOT_APPLICANTS, Execution>;
  for (const key of Object.keys(want) as Array<keyof typeof want>) {
    results[key] = await execute(auth, PILOT_APPLICANTS[key]);
    log(1, `${key} → ${results[key].outcome} (${results[key].correlationId})`);
    if (results[key].outcome !== want[key]) throw new Error(`${key} 期望 ${want[key]}，实际 ${results[key].outcome}`);
  }
  return results;
}

// 第 2 步：信贷员在收件箱找到待审项并批准
async function stepApprove(correlationId: string): Promise<void> {
  const auth = await cookieAuth('officerId');
  const inbox = await call<{ items: InboxItem[] }>(auth, 'GET', '/api/approvals?status=PENDING', 200);
  const item = inbox.items.find((i) => i.evidenceCorrelationId === correlationId);
  if (!item) throw new Error(`收件箱未找到 correlationId=${correlationId} 的待审项`);
  const path = `/api/approvals/${CREDIT_PILOT.teamId}/${item.id}/approve`;
  await call(auth, 'POST', path, 200, { comment: 'pilot: approved by Credit Officer' });
  log(2, `已批准 ${item.id}`);
}

// 第 3 步：What-If 按策略属主限定租户（ADR 0034 §4.3），分析员无法取到目标版本，故以 cp-owner 发起并轮询
async function stepWhatIf(): Promise<void> {
  const auth = await cookieAuth('ownerId');
  const base = `/api/v1/policies/${POLICY}/whatif-batches`;
  const [baseVersionId, targetVersionId] = CREDIT_PILOT.versionIds;
  const body = { baseVersionId, targetVersionId, windowKind: 'LAST_MONTH', includeToday: true };
  const batch = await call<{ batchId: string }>(auth, 'POST', base, 202, body);
  log(3, `批量 ${batch.batchId} 已创建`);
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    const cur = await call<{ status: string }>(auth, 'GET', `${base}/${batch.batchId}`, 200);
    if (cur.status === 'COMPLETED') return log(3, '批量已完成');
    if (cur.status === 'FAILED' || cur.status === 'EXPIRED') {
      throw new Error(`What-If 批量终止于 ${cur.status}：${JSON.stringify(cur)}`);
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`What-If 批量 ${batch.batchId} 超时（${POLL_LIMIT_MS / 1000}s）`);
}

// 第 4 步：报告按策略属主查找，故以 cp-owner 导出
async function stepExport(): Promise<{ manifest: { regulatoryMapping: ClauseMappingLike } }> {
  const auth = await cookieAuth('ownerId');
  const report = await call<{ id: string }>(auth, 'POST', '/api/reports', 201, { policyId: POLICY, format: 'json' });
  const bundle = await call<{ manifest: { regulatoryMapping: ClauseMappingLike } }>(
    auth, 'GET', `/api/reports/${report.id}/download`, 200,
  );
  writeFileSync(OUT, JSON.stringify(bundle, null, 2));
  log(4, `证据包已写出 ${OUT}`);
  return bundle;
}

async function main(): Promise<number> {
  const executions = await stepExecute();
  await stepApprove(executions.requireApproval.correlationId);
  await stepWhatIf();
  const bundle = await stepExport();
  const mapping = bundle.manifest?.regulatoryMapping;
  if (!mapping) throw new Error('证据包缺 manifest.regulatoryMapping');
  console.table(mapping.clauses.map((c) => ({ clause: c.clause, status: c.status, expected: EXPECTED_CLAUSE_STATUS[c.clause] })));
  const diff = diffClauses(mapping, EXPECTED_CLAUSE_STATUS);
  diff.forEach((d) => console.error(`[pilot] step 5 不符 ${d}`));
  log(5, diff.length === 0 ? '九款状态全部符合期望' : `${diff.length} 项不符`);
  return diff.length === 0 ? 0 : 2;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error('[pilot] 失败：', err);
    process.exit(1);
  },
);
