/**
 * Aster CNL 策略执行服务
 *
 * 提供共享的 CNL 格式检测、语言识别和策略执行功能。
 * 供 Dashboard 和 API v1 两个执行端点复用。
 */

import { createPolicyApiClient, PolicyApiError, type AgentIdentity, type PolicyEvaluateDiagnostic, type PolicyEvaluateResponse, type PolicyReplayMetadata, type PolicyTraceSkeleton } from './policy-api';
import { executePolicy as executeSimplePolicy } from './executor';
import type { Policy } from '@/lib/prisma';
import type { executionDecisionEnum } from '@/db/schema';

/** Verdict 四态结果码（ADR 0039 / 0041）。 */
export type VerdictOutcome = 'ALLOW' | 'DENY' | 'REQUIRE_APPROVAL' | 'ESCALATE';

const VERDICT_OUTCOMES: readonly string[] = ['ALLOW', 'DENY', 'REQUIRE_APPROVAL', 'ESCALATE'];

function asVerdictOutcome(value: unknown): VerdictOutcome | undefined {
  return typeof value === 'string' && VERDICT_OUTCOMES.includes(value) ? (value as VerdictOutcome) : undefined;
}

/** 待人工处置的结果（需批准/升级）：既非放行也非拒绝，不计入 deniedReasons。 */
function isPendingOutcome(outcome: VerdictOutcome | undefined): boolean {
  return outcome === 'REQUIRE_APPROVAL' || outcome === 'ESCALATE';
}

// CNL locale type (simplified, no longer depends on local-compiler)
export type CNLLocale = 'en-US' | 'zh-CN' | 'de-DE';

// CNL 必须特征模式 - 这些是 CNL 独有的，简单 DSL 不具备
const CNL_REQUIRED_PATTERNS = [
  // 英文语法变体
  /Module\s+\S+/im, // Module finance.loan.
  /Define\s+\w+\s+has/im, // Define Applicant has
  /Rule\s+\w+.*given/im, // Rule evaluateLoan given ...
  /^\s*capability\s+\w+/m, // capability 声明
  /^\s*use\s+\w+/m, // use 导入
  // 中文关键词语法变体
  /模块\s+\S+/m, // 模块 金融.贷款
  /定义\s+\S+\s+包含/m, // 定义 申请人 包含
  /规则\s+\S+\s+给定/m, // 规则 funcName 给定 params
  // 德语语法变体
  /Modul\s+\S+/im, // Modul finanz.kredit
  /Definiere\s+\w+\s+hat/im, // Definiere Antragsteller hat
  /Regel\s+\w+\s+gegeben/im, // Regel kreditPruefen gegeben
];

// 中文 CNL 关键字
const CHINESE_KEYWORDS = ['模块', '类型', '函数', '当', '则', '如果', '那么', '并且', '或者', '定义', '包含', '产出', '返回', '令', '为', '若'];

// 德语 CNL 关键字
//
// ★必须按**词**匹配，不能用 includes 做子串包含：
//   'Modul' 是英文 'Module' 的前缀，于是每一份以 `Module ...` 开头的
//   英文策略都会被判成德语，改用德语词典解析 —— 而德语词典里没有
//   `less than`，最终报「无法识别此处的运算符或关键词」。
//   实测：英文 loan 模板走 de-DE 时在「行 15 第 23 列」失败，
//   与用户报的位置逐字一致；走 en-US 则 PARSE_OK。
const GERMAN_KEYWORDS = ['Modul', 'Definiere', 'Falls', 'Sonst', 'Gib zurück', 'erzeuge', 'größer als', 'kleiner als', 'Ganzzahl', 'Dezimal'];

/**
 * 关键词是否作为**独立词**出现在源码里。
 *
 * <p>用 Unicode 词边界近似：关键词两侧不得紧邻字母/数字/下划线。
 * 这样 `Modul` 不会命中 `Module`，但 `Modul Finanz.Kredit.` 仍能命中。
 * 含空格的多词关键词（`Gib zurück`）同样适用。
 */
function containsWord(content: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // \p{L}/\p{N} 覆盖中德文字符；两侧用「非字母数字」断言代替 \b（\b 对非 ASCII 不可靠）
  const re = new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}($|[^\\p{L}\\p{N}_])`, 'iu');
  return re.test(content);
}

/**
 * 检测策略内容是否为 Aster CNL 格式
 *
 * CNL 格式必须包含以下结构化语法之一：
 * - module/模块 声明
 * - type/类型 定义
 * - function/函数 定义
 * - capability 能力声明
 * - use 导入语句
 *
 * 注意：简单的 "if ... then ..." 规则不被视为 CNL，
 * 因为本地 DSL 也使用相同语法，应由简单执行器处理。
 */
export function isAsterCNL(content: string): boolean {
  if (!content || content.trim().length === 0) {
    return false;
  }
  // 必须匹配至少一个 CNL 独有特征
  return CNL_REQUIRED_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * 检测 CNL 语言类型（中文/英文/德文）
 */
export function detectCNLLocale(content: string): string {
  const hasChineseKeywords = CHINESE_KEYWORDS.some((keyword) => content.includes(keyword));
  if (hasChineseKeywords) {
    return 'zh-CN';
  }
  const hasGermanKeywords = GERMAN_KEYWORDS.some((keyword) => containsWord(content, keyword));
  if (hasGermanKeywords) {
    return 'de-DE';
  }
  return 'en-US';
}

/**
 * 策略执行结果类型
 */
export interface PolicyExecutionResult {
  /** 是否允许 */
  allowed: boolean;
  /** 等同于 allowed，为兼容性保留 */
  approved: boolean;
  /** 匹配的规则列表 */
  matchedRules: string[];
  /** 拒绝原因列表 */
  deniedReasons: string[];
  /** 元数据 */
  metadata: {
    evaluatedAt: string;
    policyId: string;
    policyName: string;
    ruleCount: number;
    matchedRuleCount: number;
    denyCount: number;
    engine: 'aster-cnl' | 'simple';
    executionTime?: number;
    policyVersion?: string;
    engineError?: boolean;
    /** 仅当结果无 allow/deny 语义（成功执行但非决策，如返回纯文本/计算值）时为
     * 'indeterminate'：allowed=false（fail-closed）但 deniedReasons 为空。 */
    decision?: 'indeterminate';
    /** 简单规则引擎的规则详情 */
    rules?: Array<{
      name: string;
      action: string;
      field: string;
      operator: string;
      expected: unknown;
      actual: unknown;
      matched: boolean;
    }>;
    /**
     * 回放元数据（ADR 0030 附录 A）——仅 replayCapture=true 的 CNL 执行有；aster-api 权威侧
     * 算的回放地基 hash + 工具链。execute route 据此写 Execution 回放列。simple 引擎无。
     */
    replay?: PolicyReplayMetadata;
    /**
     * 决策骨架（Phase 0）：脱敏 trace 投影（只有条件原文 + 命中与否，无任何业务值）。
     * execute route 据此写 Execution.traceSkeletonJson，供条件漏斗 / 死分支分析。
     * ★与 replay 独立：不受 replayCapture 门控。
     */
    traceSkeleton?: PolicyTraceSkeleton;
    /**
     * Verdict 结果码（ADR 0041 §4）：优先取 aster-api 响应 decision.outcome，回退解析 result。
     * ★v2 行以 outcome 为权威：REQUIRE_APPROVAL/ESCALATE 时 allowed/approved 为 false（fail-closed），
     * 不表示拒绝；落库的 Execution.outcome 由 deriveExecutionOutcome 据此派生。
     */
    outcome?: VerdictOutcome;
    /** 命中规则的业务标识（aster-api 响应 ruleId）。 */
    ruleId?: string;
    /** 规则关联的合规控制点（aster-api 响应 controls）。 */
    controls?: string[];
    /** Verdict 理由码：优先取 aster-api 响应 decision.reason，回退取 Verdict 结果的 reason；供 reasonCodes 落库。 */
    reason?: string;
    /** aster-api 证据关联 id（响应 evidence.correlationId）。 */
    evidenceCorrelationId?: string;
    /** 模块声明的治理档案 id（aster-api 响应 profile，ADR 0046）。 */
    profile?: string;
  };
  /** CNL 引擎返回的原始结果 */
  result?: unknown;
  /** 实际执行的 CNL Rule/function 名称 */
  executedFunction?: string;
  /** CNL 引擎诊断，可用于可恢复错误 */
  diagnostics?: PolicyEvaluateDiagnostic[];
}

/**
 * 执行策略选项
 */
export interface ExecutePolicyOptions {
  /** 策略实体 */
  policy: Policy;
  /** 输入上下文 */
  input: Record<string, unknown>;
  /** 执行用户 ID */
  userId: string;
  /** 租户 ID（可选，默认使用策略的 teamId 或 userId） */
  tenantId?: string;
  /** 指定 CNL Rule/function 名称 */
  functionName?: string;
  /**
   * 已发布版本冻结的用户关键词别名（ADR 0022，kind → 多词短语数组）。执行端归一阶段据此把
   * 别名归回规范关键词，使别名写的源码能编译。由调用方（execute route）从活跃 PolicyVersion
   * 的 aliasSet 快照加载传入。冻结版本已在创建时经授权+校验+进 envelope，执行端信任应用。
   */
  aliasSet?: Record<string, string[]> | null;
  /**
   * 回放捕获（ADR 0030）：true 时向 aster-api 请求 replayCapture，响应带回放地基 hash。
   * 仅**已认证 execute 路径**应开（走 HMAC 内部调用）；aster-api 侧 gate 到 HMAC 已验证才生效。
   */
  replayCapture?: boolean;
  /** 调用方 agent 身份（ADR 0041 §4）：透传给 aster-api evaluate-source 请求体 `agent`。 */
  agent?: AgentIdentity;
}

/**
 * 统一的策略执行入口
 *
 * 自动检测策略格式并选择合适的执行引擎：
 * - CNL 格式：使用 Aster Policy API
 * - 简单规则格式：使用本地执行器
 */
export async function executePolicyUnified(
  options: ExecutePolicyOptions
): Promise<PolicyExecutionResult> {
  const { policy, input, userId, tenantId, functionName, aliasSet, replayCapture, agent } = options;
  const policyContent = policy.content || '';
  const useAsterEngine = isAsterCNL(policyContent);

  if (useAsterEngine) {
    return executeWithAsterEngine(policy, policyContent, input, userId, tenantId, functionName, aliasSet, replayCapture, agent);
  } else {
    return executeWithSimpleEngine(policy, policyContent, input, userId);
  }
}

/**
 * 使用 Aster CNL 引擎执行策略
 *
 * 执行流程：远程 API 执行（实际策略评估）
 * 本地编译验证已移至 LSP（Language Server Protocol）
 */
async function executeWithAsterEngine(
  policy: Policy,
  policyContent: string,
  input: Record<string, unknown>,
  userId: string,
  tenantId?: string,
  functionName?: string,
  aliasSet?: Record<string, string[]> | null,
  replayCapture?: boolean,
  agent?: AgentIdentity
): Promise<PolicyExecutionResult> {
  const locale = detectCNLLocale(policyContent) as CNLLocale;
  const effectiveTenantId = tenantId || policy.teamId || policy.userId;
  const apiClient = createPolicyApiClient(effectiveTenantId, userId);

  try {
    // aliasSet：已发布版本冻结的别名快照，透传给执行端使别名源码能编译（C1）。
    // replayCapture：回放地基（ADR 0030）——已认证 execute 路径开，透传 aster-api 权威 hash。
    // agent：调用方自报身份（ADR 0041 §4），由 aster-api 写入证据。
    const response = await apiClient.evaluateSource(policyContent, input, { locale, functionName, aliasSet, replayCapture, agent });
    return buildCNLResult(policy, response);
  } catch (error) {
    return buildCNLErrorResult(policy, error);
  }
}

/**
 * 使用简单规则引擎执行策略
 */
async function executeWithSimpleEngine(
  policy: Policy,
  policyContent: string,
  input: Record<string, unknown>,
  userId: string
): Promise<PolicyExecutionResult> {
  const result = await executeSimplePolicy({
    policy,
    input,
    userId,
  });

  // 从返回的 metadata 中提取字段
  const meta = result.metadata as Record<string, unknown>;
  const ruleCount = (meta.ruleCount as number) || 0;
  const matchedRuleCount = (meta.matchedRuleCount as number) || 0;
  const denyCount = (meta.denyCount as number) || 0;
  const evaluatedAt = (meta.evaluatedAt as string) || new Date().toISOString();
  // 保留规则详情，供 Dashboard/API 展示命中链路与审计
  const rules = meta.rules as PolicyExecutionResult['metadata']['rules'];

  // 安全检查：如果策略内容非空但没有匹配规则，说明解析失败
  if (policyContent.trim().length > 0 && result.matchedRules.length === 0 && ruleCount === 0) {
    console.warn('[CNLExecutor] Policy content exists but no rules parsed, failing safely');
    return {
      allowed: false,
      approved: false,
      matchedRules: [],
      deniedReasons: ['Policy could not be parsed. Please check the policy syntax.'],
      metadata: {
        evaluatedAt: new Date().toISOString(),
        policyId: policy.id,
        policyName: policy.name,
        ruleCount: 0,
        matchedRuleCount: 0,
        denyCount: 1,
        engine: 'simple',
      },
    };
  }

  return {
    allowed: result.allowed,
    approved: result.allowed,
    matchedRules: result.matchedRules,
    deniedReasons: result.deniedReasons,
    metadata: {
      evaluatedAt,
      policyId: policy.id,
      policyName: policy.name,
      ruleCount,
      matchedRuleCount,
      denyCount,
      engine: 'simple',
      rules,
    },
  };
}

/**
 * 判断一个 CNL 布尔字段值是否为真。
 *
 * 关键：CNL 引擎执行后，Bool 字段保留**本地化字面量**（中文 `真`/`假`、
 * 德文 `wahr`/`falsch`、英文 `true`/`false`），而非统一规范化为 JS boolean。
 * 例如中文 loan 策略 `批准 将 设为 真` 的执行结果是 `{ "批准": "真", ... }`。
 *
 * 此前真值判断只认 `true` / `"true"`，导致中文/德文 Bool（`真`/`wahr`）被误判
 * 为 false → 「信用良好、批准=真」却被前端判成拒绝、理由进 deniedReasons（用户
 * 反馈的违反直觉案例）。这里统一识别三语言的真/假字面量。
 */
export function isCnlTruthy(val: unknown): boolean {
  if (typeof val === 'boolean') {
    return val;
  }
  if (typeof val === 'number') {
    return val !== 0;
  }
  if (typeof val === 'string') {
    const s = val.trim().toLowerCase();
    // 三语言真值字面量。zh-CN 的 Bool 字面量是「真值/假值」（2 字，故意避免与
    // 业务标识符冲突，见 aster-lang-ts zh-CN lexicon），同时容忍单字「真/是」。
    return s === 'true' || s === '真值' || s === '真' || s === '是'
        || s === 'wahr' || s === 'ja'
        || s === 'yes' || s === '1';
  }
  return false;
}

/**
 * 从 CNL 结果中解析批准状态
 *
 * CNL 函数可能返回：
 * 1. 对象格式：{ approved: boolean, reason?: string } —— 明确的决策形态
 * 2. 字符串格式："批准，优惠利率" / "Approved with premium rate" / "Genehmigt..."
 *
 * **mode 区分两类调用路径**（合规安全边界）：
 * - `'decision'`（默认，policy execute / 准入决策路径）——**裸字符串永不 approve**：
 *   自然语言批准措辞无法被关键字法可靠识别（前置否定 not approved / 未批准、后置
 *   否定 "Approved: no" / 批准：否、撤销 previously approved now revoked 都会让
 *   「含批准词根 ⇒ 批准」fail-open）。故裸字符串只做两件事：①命中**显式拒绝/转人工**
 *   关键字 → deny（保住真实拒绝原因链）；②其余一律 **indeterminate**（approved:false，
 *   fail-closed，不伪造拒绝也绝不放行）。要在 decision 路径表达「批准」，策略必须返回
 *   **结构化决策**（boolean 或 { approved/allowed/isEligible: true, ... } 对象，走下面
 *   的对象分支）。indeterminate 在 buildCNLResult 里 allowed:false 但**不计入
 *   deniedReasons**（无真实拒绝理由，避免把计算输出伪造成拒绝）。
 * - `'value'`（preview / 计算输出路径，如 greet → "Hello, John Smith!"）：裸字符串
 *   直接视为成功的计算结果（approved=true），与 number / value 对象 / _type 对象一致
 *   ——这类路径本就不是 allow/deny 决策。
 *
 * 结构化形态（boolean / Verdict / 含批准字段对象 / value 对象 / _type 对象）在两种 mode 下
 * 行为一致——它们语义明确，不受 mode 影响。
 *
 * 不含任何判定字段的对象（如 `{}`、`{ tier: '转人工审核' }`，含数组）在两种 mode 下
 * 均为 indeterminate（approved=false，不计入拒绝）——无 allow/deny 语义可读。
 */
export type ApprovalParseMode = 'decision' | 'value';

export interface ApprovalParseResult {
  approved: boolean;
  message: string;
  /** 仅 decision 模式：结果无 allow/deny 语义，无法判定（非批准亦非真实拒绝）。 */
  indeterminate?: boolean;
  /** 结果为 Verdict 内置值时的结果码（ADR 0041 §4）。 */
  outcome?: VerdictOutcome;
}

// Bug-4 修复：导出供单测验证 isEligible 等字段被正确识别
export function parseApprovalFromResult(
  result: unknown,
  mode: ApprovalParseMode = 'decision',
): ApprovalParseResult {
  // 布尔值：直接使用
  if (typeof result === 'boolean') {
    return { approved: result, message: result ? 'Approved' : 'Denied' };
  }

  // 数值：非零视为成功（计算类策略返回数值结果）
  if (typeof result === 'number') {
    return { approved: true, message: String(result) };
  }

  // 对象格式：支持多语言字段名和通用结果格式
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;

    // Verdict 内置值（ADR 0039）：结构化决策，不走任何字段名启发式。
    if (obj.__type === 'Verdict' && typeof obj.outcome === 'string') {
      const reason = typeof obj.reason === 'string' ? obj.reason : '';
      switch (obj.outcome) {
        case 'ALLOW': return { approved: true, outcome: 'ALLOW', message: 'Approved' };
        case 'DENY': return { approved: false, outcome: 'DENY', message: reason || 'Denied' };
        // 需人工批准 / 升级（ADR 0041 §4）：专属态，由 outcome 携带；绝不能落入 approved 或 denied。
        case 'REQUIRE_APPROVAL':
        case 'ESCALATE': return { approved: false, outcome: obj.outcome, message: reason };
        default: return { approved: false, indeterminate: true, message: `Unknown verdict outcome: ${obj.outcome}` };
      }
    }

    // 支持的批准字段名（英/中/德）及通用成功标志
    // Bug-4 修复：补 isEligible（loan eligibility / KYC 类 policy 常用），并保留语义对齐
    const approvalFields = [
      'approved', 'isApproved', 'allowed', 'isAllowed',
      'isEligible', 'eligible',
      'isSuccess', 'success',
      '批准', 'genehmigt',
    ];
    // 支持的理由字段名（英/中/德）
    const reasonFields = ['reason', '理由', 'begruendung', 'message', 'errorMessage', 'description'];
    // 支持的结果值字段名（计算类策略）
    const valueFields = ['result', 'resultAmount', 'value', 'amount', 'total', 'output'];

    // 查找批准/成功字段
    const approvalField = approvalFields.find(f => f in obj);
    if (approvalField) {
      const val = obj[approvalField];
      const approved = isCnlTruthy(val);
      // 查找理由字段
      const reasonField = reasonFields.find(f => f in obj && obj[f] !== '');
      // 查找结果值字段（用于构造有意义的消息）
      const valueField = valueFields.find(f => f in obj);
      const reason = reasonField ? String(obj[reasonField])
        : valueField ? `Result: ${JSON.stringify(obj[valueField])}`
        : (approved ? 'Approved' : 'Denied');
      return { approved, message: reason };
    }

    // 没有明确的批准字段但有结果值 → 视为成功的计算结果
    const valueField = valueFields.find(f => f in obj);
    if (valueField) {
      return { approved: true, message: `Result: ${JSON.stringify(obj[valueField])}` };
    }

    // 有 _type 字段的结构化结果 → 视为成功执行
    if ('_type' in obj) {
      return { approved: true, message: JSON.stringify(result) };
    }

    // 对象里既无 Verdict、批准字段、值字段也无 _type（如 { tier: '转人工审核' }）：没有可判定的
    // allow/deny 语义（ADR 0041 §4）。fail-closed 不批准，但记 indeterminate 而非伪造拒绝。
    return { approved: false, indeterminate: true, message: 'No decision fields in result object' };
  }

  // 字符串格式（见函数头部 mode 说明）。
  //
  // **合规硬安全（decision 模式）**：裸字符串**绝不**经关键字启发式判 approve。
  // 自然语言批准措辞无法被关键字法可靠识别——前置否定（not approved / 未批准）、
  // 后置否定（"Approved: no" / "批准：否"）、撤销（previously approved, now revoked）
  // 都会让「含批准词根 ⇒ 批准」fail-open。故 decision 模式只做两件事：
  //   1. 命中**显式拒绝**关键字 → deny（保住真实拒绝/转人工的原因链，方向安全）；
  //   2. 其余一律 indeterminate（fail-closed，不伪造拒绝也绝不 fail-open 批准）。
  // 要在 decision 路径表达「批准」，策略必须返回**结构化决策**（boolean 或
  // { approved/allowed/isEligible: true, ... } 对象，走上面的分支），而非裸文本。
  //
  // value 模式（preview / 计算输出，如 greet → "Hello, John Smith!"）不是 allow/deny
  // 决策，裸字符串直接视为成功的计算结果。
  if (typeof result === 'string') {
    if (mode === 'value') {
      return { approved: true, message: result };
    }
    // decision 模式：仅识别显式拒绝/转人工（中/英/德），其余 indeterminate。
    const resultStr = result.toLowerCase();
    const denialKeywords = [
      '拒绝', '拒赔', '需要人工', '转人工', '人工审核', '转定损员', '未批准', '不批准', '未通过', '不通过',
      'denied', 'deny', 'reject', 'decline', 'refer', 'underwriting', 'adjuster',
      'ineligible', 'unacceptable', 'disapprove', 'unapproved', 'not approved', 'not accepted',
      'abgelehnt', 'einzelfallprüfung', 'einzelfallpruefung', 'schadenregulierung', 'nicht genehmigt',
    ];
    if (denialKeywords.some((kw) => resultStr.includes(kw))) {
      return { approved: false, message: result };
    }
    return { approved: false, indeterminate: true, message: result };
  }

  // 其他类型（非 string/number/object/boolean）：真正无法解释的形态。
  // decision 模式 fail-closed 拒绝；value 模式 indeterminate（无可用输出语义）。
  return mode === 'value'
    ? { approved: false, indeterminate: true, message: 'Unknown result format' }
    : { approved: false, message: 'Unknown result format' };
}

/**
 * 取 Verdict 理由：aster-api 结构化 decision.reason 为权威，旧后端无此字段时回退 result（__type=Verdict）的 reason。
 * 空串视为无理由。
 */
function verdictReasonOf(apiResponse: PolicyEvaluateResponse): string | undefined {
  if (apiResponse.decision?.reason) return apiResponse.decision.reason;
  const result = apiResponse.result as { __type?: unknown; reason?: unknown } | null | undefined;
  if (!result || typeof result !== 'object' || result.__type !== 'Verdict') return undefined;
  return typeof result.reason === 'string' && result.reason !== '' ? result.reason : undefined;
}

/**
 * 构建 CNL 执行结果
 *
 * 策略：
 * 1. 如果有 result，优先解析 result 判断批准状态
 * 2. 如果没有 result 且 success=false，返回错误
 * 3. 安全原则：fail-closed，无法解析时拒绝
 */
export function buildCNLResult(policy: Policy, apiResponse: PolicyEvaluateResponse): PolicyExecutionResult {
  // 证据字段（ADR 0041 §4）：两条分支（有/无 result）都透传，缺省则不出现对应键。
  const evidenceMetadata = {
    ...(apiResponse.ruleId ? { ruleId: apiResponse.ruleId } : {}),
    ...(apiResponse.controls ? { controls: apiResponse.controls } : {}),
    ...(apiResponse.evidence?.correlationId ? { evidenceCorrelationId: apiResponse.evidence.correlationId } : {}),
    ...(apiResponse.profile ? { profile: apiResponse.profile } : {}),
  };

  // 如果有 result，尝试解析（即使 success=false）
  // 某些情况下 API 可能返回 success=false 但仍有有效结果
  if (apiResponse.result !== undefined && apiResponse.result !== null) {
    // execute 是准入决策路径 → decision 模式（裸文本无决策语义 → indeterminate，
    // 既不伪造拒绝也不 fail-open；见 parseApprovalFromResult mode 说明）。
    const parsed = parseApprovalFromResult(apiResponse.result, 'decision');
    const { approved, message, indeterminate } = parsed;
    // aster-api 的结构化 decision 是权威来源；旧版后端无此字段时回退解析 result。
    const outcome = asVerdictOutcome(apiResponse.decision?.outcome) ?? parsed.outcome;
    const reason = verdictReasonOf(apiResponse);

    // indeterminate（成功执行但无 allow/deny 语义，如 greet 返回纯文本）与待人工处置
    // （REQUIRE_APPROVAL/ESCALATE）：fail-closed 不批准，但**不计入 deniedReasons**——
    // 没有真正的拒绝理由，避免伪造拒绝（顶层 error 取 deniedReasons[0]，故此处不进则
    // error 为空，success=allowed=false 但 result 原样回传）。
    const isDenial = !approved && !indeterminate && !isPendingOutcome(outcome);
    const deniedReasons: string[] = isDenial ? [message] : [];

    return {
      allowed: approved,
      approved,
      matchedRules: approved ? [message] : [],
      deniedReasons,
      metadata: {
        evaluatedAt: new Date().toISOString(),
        policyId: policy.id,
        policyName: policy.name,
        ruleCount: 1,
        matchedRuleCount: approved ? 1 : 0,
        denyCount: isDenial ? 1 : 0,
        engine: 'aster-cnl',
        executionTime: apiResponse.executionTimeMs,
        ...(indeterminate ? { decision: 'indeterminate' as const } : {}),
        ...(outcome ? { outcome } : {}),
        ...(reason ? { reason } : {}),
        ...evidenceMetadata,
        // 回放地基（ADR 0030）：aster-api replayCapture 返回的权威 hash，透传给 execute route 落 Execution。
        ...(apiResponse.replayMetadata ? { replay: apiResponse.replayMetadata } : {}),
        // 决策骨架（Phase 0）：脱敏 trace 投影，同样透传给 execute route 落库。
        // ★与 replay 独立：骨架不含业务值，未开 capture 时也应保留。
        ...(apiResponse.traceSkeleton ? { traceSkeleton: apiResponse.traceSkeleton } : {}),
      },
      result: apiResponse.result,
      executedFunction: apiResponse.executedFunction,
      diagnostics: apiResponse.diagnostics,
    };
  }

  // 没有 result 且调用失败，返回错误
  return {
    allowed: false,
    approved: false,
    matchedRules: [],
    deniedReasons: [apiResponse.error || 'Policy evaluation failed: no result returned'],
    metadata: {
      evaluatedAt: new Date().toISOString(),
      policyId: policy.id,
      policyName: policy.name,
      ruleCount: 0,
      matchedRuleCount: 0,
      denyCount: 1,
      engine: 'aster-cnl',
      executionTime: apiResponse.executionTimeMs,
      ...(apiResponse.replayMetadata ? { replay: apiResponse.replayMetadata } : {}),
      ...(apiResponse.traceSkeleton ? { traceSkeleton: apiResponse.traceSkeleton } : {}),
      ...evidenceMetadata,
    },
    result: apiResponse.result,
    executedFunction: apiResponse.executedFunction,
    diagnostics: apiResponse.diagnostics,
  };
}

/**
 * 构建 CNL 执行错误结果
 */
function buildCNLErrorResult(policy: Policy, error: unknown): PolicyExecutionResult {
  const errorMessage =
    error instanceof PolicyApiError
      ? `Policy evaluation failed: ${error.message}`
      : 'Failed to evaluate policy with Aster engine';

  console.error('[CNLExecutor] Aster API error:', error);

  return {
    allowed: false,
    approved: false,
    matchedRules: [],
    deniedReasons: [errorMessage],
    metadata: {
      evaluatedAt: new Date().toISOString(),
      policyId: policy.id,
      policyName: policy.name,
      ruleCount: 0,
      matchedRuleCount: 0,
      denyCount: 1,
      engine: 'aster-cnl',
      engineError: true,
    },
    diagnostics: error instanceof PolicyApiError ? error.diagnostics : undefined,
  };
}

/**
 * 获取执行结果的主要错误信息
 */
export function getPrimaryError(result: PolicyExecutionResult): string | undefined {
  return result.deniedReasons[0];
}

/** executions.decision 列的取值——直接从 schema 枚举推导，避免两处联合漂移。 */
export type ExecutionDecision = (typeof executionDecisionEnum.enumValues)[number];

/**
 * 从执行结果**服务端派生**审计决策（绝不信客户端输入）。六态互斥、按优先级判定：
 *   - engineError → 'error'（执行报错，如编译/运行失败）
 *   - outcome==='REQUIRE_APPROVAL' → 'require_approval'（需人工批准）
 *   - outcome==='ESCALATE' → 'escalate'（升级处理）
 *   - decision==='indeterminate' → 'indeterminate'（执行成功但无 allow/deny 语义，如值输出）
 *   - allowed → 'approved'
 *   - 其余 → 'denied'（真实拒绝）
 */
export function deriveExecutionDecision(result: PolicyExecutionResult): ExecutionDecision {
  if (result.metadata.engineError) return 'error';
  if (result.metadata.outcome === 'REQUIRE_APPROVAL') return 'require_approval';
  if (result.metadata.outcome === 'ESCALATE') return 'escalate';
  if (result.metadata.decision === 'indeterminate') return 'indeterminate';
  return result.allowed ? 'approved' : 'denied';
}

/** decision → Execution.outcome 大写码（证据包与 aster-api 用同一套结果码）。 */
const OUTCOME_BY_DECISION: Record<ExecutionDecision, string> = {
  approved: 'ALLOW',
  denied: 'DENY',
  require_approval: 'REQUIRE_APPROVAL',
  escalate: 'ESCALATE',
  indeterminate: 'INDETERMINATE',
  error: 'ERROR',
};

/**
 * 派生 Execution.outcome（ADR 0041 §4）：ALLOW/DENY/REQUIRE_APPROVAL/ESCALATE/INDETERMINATE/ERROR。
 * 与 deriveExecutionDecision 一一对应，新行恒非 null（null 只出现在迁移前的 legacy 行）。
 */
export function deriveExecutionOutcome(result: PolicyExecutionResult): string {
  return OUTCOME_BY_DECISION[deriveExecutionDecision(result)];
}
