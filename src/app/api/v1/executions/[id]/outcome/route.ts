/**
 * 业务结果回传（Phase 3）：POST /api/v1/executions/:id/outcome
 *
 * <p>平台只记录「批准/拒绝」，不知道该决策事后是否成交/坏账。本端点让客户在
 * 决策落地后回传真实结果——这是「改策略会少赚多少钱」这类问题的**唯一**数据来源。
 *
 * <p><b>完整对外契约见 `docs/api/outcome-ingestion.md`</b>（鉴权、幂等语义、
 * value 精度约束、错误码、并发行为）。改本文件的行为前请同步那份文档。
 *
 * <p><b>★鉴权：API Key 优先，Session 兜底。</b>本端点的主要调用方是**客户后台**
 * ——决策落地几天后才知道结局，那时早已不是一次浏览器会话。同层的
 * `/api/v1/policies/:id/execute` 用 API Key，本端点若只认 cookie session，
 * 客户拿已有的 key 根本回传不了（第四轮交叉审查指出的契约不匹配）。
 *
 * <p>Session 仍然保留：控制台里人工补录/更正结局是真实需求，不该逼用户去建 key。
 *
 * <p>幂等：同一 executionId 重复回传会**覆盖**而非堆叠（结局只有一个，
 * 更正是正常需求），且只有**业务时间不早于**已存记录才覆盖；未生效时
 * 响应 `applied:false` 如实告知。详见下方 upsert 处注释。
 */
import { NextRequest, NextResponse } from 'next/server';
import { getSession } from '@/lib/auth';
import { authenticateApiRequest } from '@/lib/api-keys';
import { db, executions, executionOutcomes } from '@/lib/prisma';
import { and, eq, sql } from 'drizzle-orm';
import { errorEnvelope } from '@/lib/api/error-envelope';

export const dynamic = 'force-dynamic';

/** outcome 词汇由租户自定义，但仍需限长——防止把它当自由文本字段塞大对象。 */
const MAX_OUTCOME_LEN = 64;
const MAX_NOTE_LEN = 1024;

/** numeric(20,4)：总位数 20、小数 4 位 ⇒ 整数部分最多 16 位。 */
const VALUE_SCALE = 4;
const VALUE_INT_DIGITS = 16;

/** 十进制字面量：可选负号 + 整数部分 + 可选小数部分。不接受指数记法。 */
const DECIMAL_RE = /^-?\d+(\.\d+)?$/;

/**
 * 按 `numeric(20,4)` 契约在**字符串域**解析金额。
 *
 * <p>只接受 number 与十进制字符串两种输入，且全程不经过 `Number()`——
 * 见调用处注释说明为什么隐式转换在金额字段上是有害的。
 *
 * <p>拒绝指数记法（`1e20`）：它既容易越界，也不是人类填写金额的形式；
 * 与其猜测意图不如让调用方显式写清楚。
 */
function parseDecimalValue(
  raw: unknown,
): { ok: true; value: string } | { ok: false; message: string } {
  let text: string;
  if (typeof raw === 'number') {
    // 只挡 NaN/Infinity；位数与范围统一交给下面的字符串校验，避免两套口径。
    if (!Number.isFinite(raw)) return { ok: false, message: 'value must be a finite number.' };
    text = String(raw);
    // JS number 用 String() 可能产出指数记法（如 1e21），转成十进制再校验
    if (!DECIMAL_RE.test(text)) {
      return { ok: false, message: 'value exceeds the exact numeric range; provide it as a string.' };
    }
  } else if (typeof raw === 'string') {
    text = raw.trim();
    if (text === '') return { ok: false, message: 'value must not be an empty string.' };
  } else {
    // boolean / 数组 / 对象一律拒绝——Number() 会把它们静默变成 0 或 1
    return { ok: false, message: 'value must be a number or decimal string.' };
  }

  if (!DECIMAL_RE.test(text)) {
    return { ok: false, message: 'value must be a decimal number (exponent notation is not supported).' };
  }

  const negative = text.startsWith('-');
  const digits = negative ? text.slice(1) : text;
  const [intPart, fracPart = ''] = digits.split('.');

  if (fracPart.length > VALUE_SCALE) {
    return { ok: false, message: `value may have at most ${VALUE_SCALE} decimal places.` };
  }
  // 去前导零后再数位数，"0000123" 不算超长
  const significantInt = intPart.replace(/^0+/, '');
  if (significantInt.length > VALUE_INT_DIGITS) {
    return { ok: false, message: `value may have at most ${VALUE_INT_DIGITS} integer digits.` };
  }

  // 规范化：去掉前导零和多余符号，保留原始小数位（不四舍五入、不补零，
  // 交给 PostgreSQL 按列定义存储）
  const normalizedInt = significantInt === '' ? '0' : significantInt;
  const body = fracPart === '' ? normalizedInt : `${normalizedInt}.${fracPart}`;
  // 负零归一成 0
  const isZero = normalizedInt === '0' && /^0*$/.test(fracPart);
  return { ok: true, value: negative && !isZero ? `-${body}` : body };
}

/**
 * 解析调用方身份：API Key 优先，Session 兜底。
 *
 * <p>顺序不是随意的——带了 `Authorization: Bearer` 就说明调用方**打算**用 key
 * 认证，此时 key 无效就该报 401，而不是悄悄回落到浏览器 session（那会让一个
 * 拿着过期 key 的后台任务，因为恰好带了某人的 cookie 而写成功，且写到**那个人**
 * 名下）。回落只发生在完全没有 Authorization 头的情况。
 *
 * @returns ok 时带 userId 与 via（供审计区分来源）
 */
async function resolveCaller(
  request: NextRequest,
): Promise<{ ok: true; userId: string; via: 'apiKey' | 'session' } | { ok: false; message: string }> {
  if (request.headers.get('authorization')) {
    const res = await authenticateApiRequest(request);
    if (!res.success) {
      return { ok: false, message: res.error };
    }
    return { ok: true, userId: res.userId, via: 'apiKey' };
  }

  const session = await getSession();
  if (!session?.user?.id) {
    return { ok: false, message: 'Not authenticated and no API key was provided.' };
  }
  return { ok: true, userId: session.user.id, via: 'session' };
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // ★双通道鉴权：带 Authorization: Bearer 就走 API Key，否则回落 session。
  //   不做成「二选一」是因为两类调用方都真实存在（客户后台 / 控制台人工补录）。
  const auth = await resolveCaller(request);
  if (!auth.ok) {
    return errorEnvelope({ code: 'UNAUTHORIZED', message: auth.message, status: 401 });
  }
  const callerUserId = auth.userId;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorEnvelope({ code: 'INVALID_JSON', message: 'Request body must be valid JSON.', status: 400 });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return errorEnvelope({ code: 'INVALID_JSON', message: 'Request body must be a JSON object.', status: 400 });
  }
  const b = body as Record<string, unknown>;

  const outcome = typeof b.outcome === 'string' ? b.outcome.trim() : '';
  if (!outcome) {
    return errorEnvelope({ code: 'INVALID_OUTCOME', message: 'outcome is required.', status: 400 });
  }
  if (outcome.length > MAX_OUTCOME_LEN) {
    return errorEnvelope({
      code: 'INVALID_OUTCOME',
      message: `outcome exceeds the ${MAX_OUTCOME_LEN}-character limit.`,
      status: 400,
    });
  }

  // ★value 在**字符串域**按 numeric(20,4) 契约严格校验，绝不走 Number() 隐式转换。
  //
  //   Number() 太宽松，会把明显不是金额的东西静默变成数字：
  //     "" → 0、"   " → 0、false → 0、[] → 0、true → 1
  //   金额字段收到这些应当是 400，而不是记一笔 0 元——后者会直接污染
  //   Phase 4 的均值估算，且事后完全查不出来。
  //
  //   同时 JS number 只有 ~15-16 位有效数字，"1234567890123456.1234" 经
  //   Number() 会被截成 1234567890123456（小数部分静默丢失）；而 1e20 能通过
  //   Number.isFinite 却超出 numeric(20,4) 的范围，落库时 PostgreSQL 直接
  //   报 numeric field overflow → 500。两者都必须在入口挡掉。
  let value: string | null = null;
  if (b.value !== undefined && b.value !== null) {
    const parsed = parseDecimalValue(b.value);
    if (!parsed.ok) {
      return errorEnvelope({ code: 'INVALID_VALUE', message: parsed.message, status: 400 });
    }
    value = parsed.value;
  }

  // ★occurredAt 必须是 ISO 8601 **字符串**，不接受数字/布尔。
  //
  //   原实现走 new Date(String(x))，把非字符串输入静默变成一个合法日期：
  //     0 → 2000-01-01（"0" 被当成年份）、1 → 2001-01-01、true → Invalid（侥幸挡住）
  //   而 occurredAt 直接决定 last-write-wins 的胜负——一个被误读成 2000 年的
  //   时间戳会让这条回传永远打不过已存记录，或反过来把正确记录挤掉。
  //   文档（docs/api/outcome-ingestion.md）写的就是 ISO 字符串，实现必须一致。
  let occurredAt: Date | null = null;
  if (b.occurredAt !== undefined && b.occurredAt !== null) {
    if (typeof b.occurredAt !== 'string') {
      return errorEnvelope({
        code: 'INVALID_DATE',
        message: 'occurredAt must be an ISO 8601 string.',
        status: 400,
      });
    }
    const raw = b.occurredAt.trim();
    // 至少要有 YYYY-MM-DD 的形状——挡掉 "0"/"2026" 这类被 Date 当成年份的输入
    const shape = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/.exec(raw);
    if (!shape) {
      return errorEnvelope({
        code: 'INVALID_DATE',
        message: 'occurredAt must be a valid ISO 8601 date, such as 2026-03-14T08:00:00Z.',
        status: 400,
      });
    }
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      return errorEnvelope({ code: 'INVALID_DATE', message: 'occurredAt is not a valid time.', status: 400 });
    }
    // ★形状对 + Date 能解析，**仍然不够**：JS 会把不存在的日期静默归一，
    //   2026-02-30 → 2026-03-02，既不报错也不是调用方的本意，
    //   而这个被改写的时间会直接参与 last-write-wins 的胜负判定。
    //
    //   校验方式：单独把「年-月-日」当 UTC 零点构造一次再回读。
    //   **不能**直接拿原始字符串解析出的 d 做比对——带时区偏移的合法输入
    //   （如 2026-03-14T23:00:00+14:00）本就会落到另一个 UTC 日，
    //   那样会把正确的时间戳误判成 400。日历日的合法性与时区无关。
    const [, yy, mm, dd] = shape;
    const probe = new Date(Date.UTC(Number(yy), Number(mm) - 1, Number(dd)));
    if (
      probe.getUTCFullYear() !== Number(yy) ||
      probe.getUTCMonth() + 1 !== Number(mm) ||
      probe.getUTCDate() !== Number(dd)
    ) {
      return errorEnvelope({
        code: 'INVALID_DATE',
        message: `occurredAt is not a real calendar date: ${raw}.`,
        status: 400,
      });
    }
    occurredAt = d;
  }

  const note = typeof b.note === 'string' ? b.note.slice(0, MAX_NOTE_LEN) : null;

  // ★租户隔离：必须同时按 executionId 和 userId 查。只按 id 查会让任何登录用户
  //   往别人的执行上写结果，污染他人的业务统计（本仓多次出现同类跨租户写）。
  const rows = await db
    .select({ id: executions.id, policyId: executions.policyId })
    .from(executions)
    .where(and(eq(executions.id, id), eq(executions.userId, callerUserId)))
    .limit(1);
  if (rows.length === 0) {
    // 404 而非 403：不泄露「该执行存在但不属于你」
    return errorEnvelope({ code: 'NOT_FOUND', message: 'Execution not found.', status: 404 });
  }

  const written = await db
    .insert(executionOutcomes)
    .values({
      id: globalThis.crypto.randomUUID(),
      executionId: id,
      userId: callerUserId,
      policyId: rows[0].policyId,
      outcome,
      value,
      occurredAt,
      note,
    })
    // ★同一执行只保留**业务时间最新**的结局，而不是最后到达的那条。
    //
    // where 限定只有 occurredAt 更新才覆盖：客户端重试、网络乱序都很常见，
    // 若无条件覆盖，「A 超时 → B 更正 → A 延迟重试」会让旧的 A 回滚掉 B，
    // 业务结局被静默改错。加了这个守卫后，迟到的旧数据是 no-op。
    //
    // 同 occurredAt 的重复投递同样不写（连 reportedAt 也不刷新），故重复请求
    // 真正幂等——上游可以安全地无脑重试。
    //
    // occurredAt 可空，故不能直接写 `旧 < 新`（NULL 比较恒为 NULL，永远不更新）。
    // 三种情形分开处理：
    //   · 新值非空、旧值为空 → 新的信息更全，允许覆盖
    //   · 新值非空、旧值非空 → 只有**不早于**旧值才覆盖。用 <= 而非 <：
    //     同一业务时间的更正是合法需求（填错了 outcome 立刻改），
    //     若用 < 会把它一并拒掉，且接口仍返回 ok，等于静默丢弃用户的更正。
    //     乱序重试的危害来自**更早**的业务时间，等于不构成回滚风险。
    //   · 新值为空 → 调用方没提供业务时间，无从比较；此时**只允许覆盖同样没有
    //     业务时间的那条**，不能让一条无时间的迟到重试抹掉带时间的更正。
    // ★同 occurredAt 的两条**不同**更正靠到达顺序决出胜负（后到者赢）。这一点
    // 无法在单条 upsert 里消除，也不该假装消除——真正要避免的是调用方
    // **误以为**自己的写生效了。故下面用 returning() 如实回报是否落库。
    .onConflictDoUpdate({
      target: executionOutcomes.executionId,
      set: { outcome, value, occurredAt, note, reportedAt: new Date() },
      where: occurredAt
        // ★必须显式转 ISO 字符串 + ::timestamp：把裸 Date 插进 sql`` 模板时，
        //   postgres.js 拿不到列的类型信息，会抛
        //   "The string argument must be of type string ... Received an instance of Date"。
        //   drizzle 的 .values() 走的是带类型的参数绑定，所以只有这里的手写
        //   模板受影响 —— 这条是 route→真库 E2E 抓到的，复制 SQL 的测试测不出。
        ? sql`${executionOutcomes.occurredAt} IS NULL OR ${executionOutcomes.occurredAt} <= ${occurredAt.toISOString()}::timestamp`
        : sql`${executionOutcomes.occurredAt} IS NULL`,
    })
    .returning({ executionId: executionOutcomes.executionId });

  // ★守卫拦下时 returning 为空 —— 必须如实告知，不能一律 ok:true。
  // 否则调用方无从区分「已记录」和「被判定为过期、静默丢弃」，
  // 而后者恰恰是它需要知道的（可能要拿更新的业务时间重试）。
  const applied = written.length > 0;
  return NextResponse.json({
    ok: true,
    executionId: id,
    outcome,
    applied,
    ...(applied
      ? {}
      : { reason: 'STALE_OCCURRED_AT', message: 'A later outcome already exists; this update was not applied.' }),
  });
}
