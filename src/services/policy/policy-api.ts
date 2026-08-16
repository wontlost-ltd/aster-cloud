/**
 * Aster Policy API 客户端
 *
 * 连接到部署在 K3S 上的 Quarkus Policy API 服务。
 * 支持 REST 和 WebSocket 两种调用方式。
 */

import { signRequest, signInternalCallerHeaders } from '@/lib/api-signing';
import { API_ENDPOINTS } from '@/config/api-versions';

// 环境变量配置
const getApiConfig = () => {
  const isServer = typeof window === 'undefined';
  return {
    // 服务端优先使用内部网络地址（容器间通信），回退到公开地址
    baseUrl: isServer
      ? (process.env.ASTER_POLICY_API_INTERNAL_URL || process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL || 'https://policy.aster-lang.dev')
      : (process.env.NEXT_PUBLIC_ASTER_POLICY_API_URL || 'https://policy.aster-lang.dev'),
    wsUrl: process.env.NEXT_PUBLIC_ASTER_POLICY_WS_URL || 'wss://policy.aster-lang.dev/ws/preview',
    timeout: parseInt(process.env.ASTER_POLICY_API_TIMEOUT || '30000', 10),
  };
};

// 请求类型定义
export interface PolicyEvaluateRequest {
  /** 策略模块名称 (如 "aster.finance.loan") */
  policyModule: string;
  /** 策略函数名称 (如 "evaluateLoanEligibility") */
  policyFunction: string;
  /** 评估上下文数据 */
  context: Record<string, unknown>[];
  /** CNL 语言 (可选，默认 en-US) */
  locale?: string;
}

export interface PolicyEvaluateBatchRequest {
  /** 策略模块名称 */
  policyModule: string;
  /** 策略函数名称 */
  policyFunction: string;
  /** 批量评估上下文数据 */
  contexts: Record<string, unknown>[][];
  /** CNL 语言 */
  locale?: string;
}

export interface PolicyCompileRequest {
  /** 策略源代码 (CNL 格式) */
  source: string;
  /** CNL 语言 */
  locale?: string;
  /**
   * 用户自定义关键词别名（ADR 0022，kind → 多词短语数组）。编译前归一阶段据此
   * 把别名归回规范关键词——保存前的编译校验必须与执行用同一 aliasSet，否则
   * 依赖别名的合法源码会被「不带 alias 的编译」误判为解析错误。
   */
  aliasSet?: Record<string, string[]> | null;
}

/**
 * 回放元数据（ADR 0030 附录 A）——aster-api replayCapture 模式产出的回放地基。
 *
 * ★权威 hash 由 aster-api（Java 评估侧）计算，cloud 只**存储**写 Execution 列，不重算、
 * 不覆盖。字段与 Java {@code io.aster.policy.replay.ReplayMetadata} record 对齐，全可选
 * （replayCapture 未开或非 HMAC 内部调用时后端不返回此字段）。
 */
export interface PolicyReplayMetadata {
  /** 运行时工具链身份（abi/core/validator/build）。 */
  runtimeToolchainId?: string;
  /** canonical 算法版本（aster-canonical-json/vN）。 */
  canonicalizationVersion?: string;
  /** 请求级 context 的 canonical hash（null=未提供/未捕获）。 */
  canonicalInputHash?: string | null;
  /** 业务 result 的 canonical hash。 */
  canonicalOutputHash?: string | null;
  /** 决策级 trace 的 canonical hash（M1 决策级非步骤级）。 */
  traceHash?: string | null;
  /** 结构化 reason（M1 恒空 []）。 */
  reasonCodes?: unknown[];
  /** 回放完整性状态：REPLAYABLE / NON_REPLAYABLE。 */
  replayabilityStatus?: string;
  /** NON_REPLAYABLE 时的具体原因（`<field>_hash_failed: ...`）。 */
  replayabilityReasons?: string[];
}

// 响应类型定义
export interface PolicyEvaluateResponse {
  /** 评估结果 */
  result: unknown;
  /** 执行时间 (毫秒) */
  executionTimeMs: number;
  /** 错误信息 (null 表示成功) */
  error: string | null;
  /** 实际执行的 Rule/function 名称 */
  executedFunction?: string;
  /** 可恢复或阻断性诊断 */
  diagnostics?: PolicyEvaluateDiagnostic[];
  /** 回放元数据（仅 replayCapture=true + HMAC 内部调用时后端返回，ADR 0030）。 */
  replayMetadata?: PolicyReplayMetadata;
  /**
   * 决策骨架（Phase 0）：DecisionTrace 的**脱敏**投影，只含条件原文与命中与否。
   *
   * <p>与 replayMetadata 同分支产出（后端只要内部构建了 DecisionTrace 就附带）。
   * ★不含任何业务值，故不受 replayRetentionEnabled 门控——这正是它的设计目的：
   * 零 PII 成本支撑条件漏斗 / 死分支分析。
   */
  traceSkeleton?: PolicyTraceSkeleton;
}

/** 决策骨架（对应 aster-api io.aster.policy.replay.TraceSkeleton）。 */
export interface PolicyTraceSkeleton {
  /** 骨架 schema 版本，消费侧据此判断字段语义。 */
  schemaVersion: string;
  moduleName?: string | null;
  functionName?: string | null;
  steps: PolicyTraceSkeletonStep[];
}

/** 单个判定步骤。★结构上无 result 字段——见 aster-api TraceSkeleton 类注释。 */
export interface PolicyTraceSkeletonStep {
  /** `<depth>.<sequence>`，同一策略跨执行稳定，供聚合对齐。 */
  stepId: string;
  /** 条件原文（策略源码片段，非用户数据）。 */
  expression: string;
  /** 该条件是否判定为真。 */
  matched: boolean;
  depth: number;
}

export interface PolicyEvaluateDiagnostic {
  code: string;
  message: string;
  candidates?: string[];
}

export interface PolicyCompileResponse {
  /** 是否成功 */
  success: boolean;
  /** 编译后的模块信息 */
  module?: {
    name: string;
    functions: string[];
    types: string[];
  };
  /** 诊断信息 */
  diagnostics?: PolicyDiagnostic[];
  /** 错误信息 */
  error?: string;
}

export interface PolicyDiagnostic {
  /** 严重级别 */
  severity: 'error' | 'warning' | 'info' | 'hint';
  /** 消息内容 */
  message: string;
  /** 开始行号 (1-based) */
  startLine: number;
  /** 开始列号 (1-based) */
  startColumn: number;
  /** 结束行号 */
  endLine: number;
  /** 结束列号 */
  endColumn: number;
  /** 错误代码 */
  code?: string;
}

export interface HealthCheckResponse {
  status: 'UP' | 'DOWN';
  checks?: Array<{
    name: string;
    status: 'UP' | 'DOWN';
  }>;
}

// Schema 类型定义（用于动态表单生成）
export type TypeKind = 'primitive' | 'struct' | 'enum' | 'list' | 'map' | 'option' | 'result' | 'function' | 'unknown';

export interface FieldInfo {
  /** 字段名称 */
  name: string;
  /** 字段类型显示名称 */
  type: string;
  /** 字段类型分类 */
  typeKind: TypeKind;
}

export interface ParameterInfo {
  /** 参数名称 */
  name: string;
  /** 参数类型显示名称 */
  type: string;
  /** 参数类型分类 */
  typeKind: TypeKind;
  /** 是否可选 */
  optional: boolean;
  /** 参数位置（0 开始） */
  position: number;
  /** 结构体字段（仅 struct 类型） */
  fields?: FieldInfo[];
}

export interface PolicySchemaRequest {
  /** 策略源代码 (CNL 格式) */
  source: string;
  /** 目标函数名（可选，默认使用第一个函数） */
  functionName?: string;
  /** CNL 语言 */
  locale?: string;
}

export interface PolicySchemaResponse {
  /** 是否成功 */
  success: boolean;
  /** 模块名称 */
  moduleName?: string;
  /** 函数名称 */
  functionName?: string;
  /** 参数列表 */
  parameters?: ParameterInfo[];
  /** 错误信息 */
  error?: string;
}

export interface AsterModuleCatalogVersion {
  version: number;
  publishedAt: string;
}

export interface AsterModuleCatalogEntry {
  moduleName: string;
  functionName: string;
  versions: AsterModuleCatalogVersion[];
}

export interface AsterModuleCatalogResponse {
  modules: AsterModuleCatalogEntry[];
}

// WebSocket 消息类型
export interface PreviewMessage {
  type: 'preview' | 'error' | 'diagnostics';
  data: unknown;
}

/**
 * Policy API 客户端类
 */
export class PolicyApiClient {
  private readonly baseUrl: string;
  private readonly wsUrl: string;
  private readonly timeout: number;
  private ws: WebSocket | null = null;

  constructor(
    private readonly tenantId: string,
    private readonly userId: string,
    private readonly userRole: string = 'member',
    /** v1.2：业务角色用于 WAADR 北极星指标 — business_expert / compliance_officer / risk_analyst / engineer / admin */
    private readonly businessRole: string = 'unknown'
  ) {
    const config = getApiConfig();
    this.baseUrl = config.baseUrl;
    this.wsUrl = config.wsUrl;
    this.timeout = config.timeout;
  }

  /**
   * 创建请求头
   */
  private getHeaders(): HeadersInit {
    return {
      'Content-Type': 'application/json',
      'X-Tenant-Id': this.tenantId,
      'X-User-Id': this.userId,
      'X-User-Role': this.userRole,
      // v1.2：业务角色不同于 RBAC 角色，专用于 WAADR 北极星指标过滤
      'X-User-Business-Role': this.businessRole,
    };
  }

  /**
   * 发送 HTTP 请求
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const url = `${this.baseUrl}${path}`;
      // ★签名/路由匹配用**纯 pathname**（不含 query）——aster-api InternalCallerFilter 签
      // ctx.getUriInfo().getPath()=纯 path 不含 query；且下方内部签名判断是 pathname 精确匹配。
      // fetch URL 仍用完整 path（含 ?replayCapture=true 等业务 query，aster-api @QueryParam 接收）。
      // 若把 query 拼进签名 path，会双重破：精确匹配失效→不发 HMAC 头→internal_only；即便发也
      // 签名 mismatch 403（ADR 0030 回放地基写路径，Codex 设计审 go/no-go）。
      const pathname = path.split('?')[0];
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const headers: Record<string, string> = {
        ...this.getHeaders() as Record<string, string>,
      };

      if (process.env.ASTER_HMAC_SECRET) {
        const sigHeaders = await signRequest(method, url, bodyStr);
        Object.assign(headers, sigHeaders);
      }

      // /evaluate-source 受 InternalCallerFilter 保护：必须带 X-Internal-Caller + HMAC 签名
      // 防止外部客户绕过审核流提交未批准源码（详见 AKA-9）
      // 红队 P0-C：签名绑定 body + tenant + role，参数须与 headers 里实际发送的一致。
      // What-If 批次同样受 InternalCallerFilter 保护：它按窗口重跑历史执行，
      // 属于「内部编排」而非终端用户可直呼的能力（ADR 0034 §7.2 的权益判定在 api 侧）。
      const needsInternalCaller =
        pathname === API_ENDPOINTS.evaluateSource || /\/whatif-batches(\/|$)/.test(pathname);
      if (needsInternalCaller && process.env.ASTER_PLAN_GATE_HMAC_KEY) {
        const internalHeaders = await signInternalCallerHeaders(
          method, pathname, bodyStr, this.tenantId, this.userRole,
        );
        Object.assign(headers, internalHeaders);
      }

      // OTEL-1: 注入 W3C traceparent，让 aster-api 端的 OTel span 与 cloud 串起来
      const { newTraceContext } = await import('@/lib/trace-context');
      headers['traceparent'] = newTraceContext().traceparent;

      const response = await fetch(url, {
        method,
        headers,
        body: bodyStr,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new PolicyApiError(
          errorData.message || `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          errorData.code,
          Array.isArray(errorData.diagnostics) ? errorData.diagnostics : undefined
        );
      }

      return response.json();
    } catch (error) {
      if (error instanceof PolicyApiError) {
        throw error;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        throw new PolicyApiError('Request timeout', 408, 'TIMEOUT');
      }
      throw new PolicyApiError(
        error instanceof Error ? error.message : 'Unknown error',
        500,
        'UNKNOWN'
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 评估单个策略
   */
  async evaluate(request: PolicyEvaluateRequest): Promise<PolicyEvaluateResponse> {
    return this.request<PolicyEvaluateResponse>('POST', API_ENDPOINTS.evaluate, request);
  }

  /**
   * 批量评估策略
   */
  async evaluateBatch(request: PolicyEvaluateBatchRequest): Promise<PolicyEvaluateResponse[]> {
    return this.request<PolicyEvaluateResponse[]>('POST', API_ENDPOINTS.evaluateBatch, request);
  }

  /**
   * 编译策略 (验证语法)
   */
  async compile(request: PolicyCompileRequest): Promise<PolicyCompileResponse> {
    const hasAliases =
      request.aliasSet != null && Object.keys(request.aliasSet).length > 0;
    return this.request<PolicyCompileResponse>('POST', API_ENDPOINTS.compile, {
      source: request.source,
      locale: request.locale || 'en-US',
      // 仅在有别名时携带（与 evaluateSource 一致），避免空字段增大请求体。
      ...(hasAliases ? { aliasSet: request.aliasSet } : {}),
    });
  }

  /**
   * 获取策略参数模式
   */
  /**
   * 创建 What-If 批次（ADR 0034）。
   *
   * <p>★透传 aster-api 的状态码语义，不在 cloud 侧改写：
   * 403=无权益（引导升级）、409=并发超限（提示等待）——两者前端要能区分。
   */
  async createWhatIfBatch(
    policyId: string,
    body: {
      baseVersionId: string;
      targetVersionId: string;
      windowKind: string;
      customFrom?: string;
      customTo?: string;
      /** 右边界是否延伸到此刻（默认 false = 当天 00:00）。 */
      includeToday?: boolean;
    },
  ): Promise<unknown> {
    return this.request('POST', API_ENDPOINTS.whatIfBatches(policyId), body);
  }

  /** 查询 What-If 批次进度/结果。 */
  async getWhatIfBatch(policyId: string, batchId: string): Promise<unknown> {
    return this.request('GET', API_ENDPOINTS.whatIfBatch(policyId, batchId));
  }

  async getSchema(
    source: string,
    options?: { functionName?: string; locale?: string }
  ): Promise<PolicySchemaResponse> {
    return this.request<PolicySchemaResponse>('POST', API_ENDPOINTS.schema, {
      source,
      functionName: options?.functionName,
      locale: options?.locale || 'en-US',
    });
  }

  /**
   * 获取当前租户可引用的已发布模块目录
   */
  async getModuleCatalog(): Promise<AsterModuleCatalogResponse> {
    return this.request<AsterModuleCatalogResponse>('GET', API_ENDPOINTS.moduleCatalog);
  }

  /**
   * 直接评估策略源代码
   */
  async evaluateSource(
    source: string,
    context: Record<string, unknown> | unknown[],
    options?: {
      locale?: string;
      functionName?: string;
      /**
       * 领域词汇表（DomainVocabulary 的 JSON）。ADR 0014 线C：发布的策略
       * 携带其快照领域词汇，使执行端规范化阶段能翻译用户自定义术语。
       */
      vocabulary?: Record<string, unknown>;
      /**
       * 用户自定义关键词别名（ADR 0022，kind → 多词短语数组）。已发布版本冻结的 aliasSet
       * 快照，执行端归一阶段据此把别名归回规范关键词。冻结版本 = 已在创建时经授权+校验+进
       * envelope，故执行端按 allowStructural=true 信任应用（见 aster-api evaluate-source）。
       */
      aliasSet?: Record<string, string[]> | null;
      /**
       * 回放捕获（ADR 0030）：true 时以 `?replayCapture=true` 请求 aster-api，响应带
       * replayMetadata（回放地基 hash + 工具链）。仅**已认证 execute 路径**（走 HMAC 内部
       * 调用）应开——aster-api 侧也 gate 到 HMAC 已验证才生效，匿名/trial 传了也被忽略。
       * query param 只进 fetch URL，**不进 HMAC 签名 path**（见 request()）。
       */
      replayCapture?: boolean;
    }
  ): Promise<PolicyEvaluateResponse> {
    const hasAliases = options?.aliasSet != null && Object.keys(options.aliasSet).length > 0;
    // replayCapture 走 query param（aster-api @QueryParam("replayCapture")）；path 拼 query 供
    // fetch，但 request() 签名/精确匹配用 pathname（split('?')[0]），不受 query 影响。
    const path = options?.replayCapture
      ? `${API_ENDPOINTS.evaluateSource}?replayCapture=true`
      : API_ENDPOINTS.evaluateSource;
    return this.request<PolicyEvaluateResponse>('POST', path, {
      source,
      context,
      locale: options?.locale || 'en-US',
      ...(options?.functionName ? { functionName: options.functionName } : {}),
      // 仅在有词汇时携带，避免空字段无谓增大请求体。
      ...(options?.vocabulary ? { vocabulary: options.vocabulary } : {}),
      // 仅在有别名时携带；已发布版本冻结的别名快照。
      ...(hasAliases ? { aliasSet: options!.aliasSet } : {}),
    });
  }

  /**
   * 健康检查
   */
  async healthCheck(): Promise<HealthCheckResponse> {
    return this.request<HealthCheckResponse>('GET', API_ENDPOINTS.healthLive);
  }

  /**
   * 就绪检查
   */
  async readinessCheck(): Promise<HealthCheckResponse> {
    return this.request<HealthCheckResponse>('GET', API_ENDPOINTS.healthReady);
  }

  /**
   * 连接 WebSocket 进行实时预览
   */
  connectPreview(
    onMessage: (message: PreviewMessage) => void,
    onError?: (error: Error) => void,
    onClose?: () => void,
    onOpen?: () => void
  ): () => void {
    if (this.ws) {
      this.ws.close();
    }

    const wsUrlWithParams = `${this.wsUrl}?tenantId=${encodeURIComponent(this.tenantId)}&userId=${encodeURIComponent(this.userId)}`;
    this.ws = new WebSocket(wsUrlWithParams);

    this.ws.onopen = () => {
      console.log('[PolicyAPI] WebSocket connected');
      onOpen?.();
    };

    this.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as PreviewMessage;
        onMessage(message);
      } catch (error) {
        console.error('[PolicyAPI] Failed to parse WebSocket message:', error);
      }
    };

    this.ws.onerror = (event) => {
      console.error('[PolicyAPI] WebSocket error:', event);
      onError?.(new Error('WebSocket connection error'));
    };

    this.ws.onclose = () => {
      console.log('[PolicyAPI] WebSocket disconnected');
      onClose?.();
    };

    // 返回断开连接的函数
    return () => {
      this.ws?.close();
      this.ws = null;
    };
  }

  /**
   * 发送预览请求
   *
   * @param source - 策略源代码
   * @param context - 评估上下文，支持单个对象或数组格式（与 REST API 保持一致）
   * @param locale - CNL 语言
   */
  sendPreview(
    source: string,
    context: Record<string, unknown> | Record<string, unknown>[],
    locale?: string
  ): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.warn('[PolicyAPI] WebSocket not connected');
      return;
    }

    // 统一为数组格式，与 REST API 保持一致
    const normalizedContext = Array.isArray(context) ? context : [context];

    this.ws.send(JSON.stringify({
      type: 'preview',
      source,
      context: normalizedContext,
      locale: locale || 'en-US',
    }));
  }

  /**
   * 断开 WebSocket 连接
   */
  disconnect(): void {
    this.ws?.close();
    this.ws = null;
  }
}

/**
 * Policy API 错误类
 */
export class PolicyApiError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number,
    public readonly code?: string,
    public readonly diagnostics?: PolicyEvaluateDiagnostic[]
  ) {
    super(message);
    this.name = 'PolicyApiError';
  }
}

/**
 * 创建 Policy API 客户端 (服务端使用)
 */
export function createPolicyApiClient(
  tenantId: string,
  userId: string,
  userRole?: string,
  businessRole?: string
): PolicyApiClient {
  return new PolicyApiClient(tenantId, userId, userRole, businessRole);
}

/**
 * 将 API 诊断转换为 Monaco 诊断格式
 */
export function toMonacoDiagnostics(diagnostics: PolicyDiagnostic[]) {
  return diagnostics.map((d) => ({
    severity: d.severity === 'error' ? 8 : d.severity === 'warning' ? 4 : 2, // Monaco.MarkerSeverity
    message: d.message,
    startLineNumber: d.startLine,
    startColumn: d.startColumn,
    endLineNumber: d.endLine,
    endColumn: d.endColumn,
    code: d.code,
  }));
}
