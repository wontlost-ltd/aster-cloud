'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CLIENT_CAPABILITIES } from '@/hooks/use-deployment-mode';
import {
  extractSchema,
  generateFieldValue,
  generateInputValues,
  EN_US,
  ZH_CN,
  DE_DE,
  type ParameterInfo,
  type FieldInfo,
  type SchemaResult,
  type Lexicon,
} from '@aster-cloud/aster-lang-ts/browser';

const FUNCTION_LABEL: Record<string, string> = {
  'en-US': 'Function',
  'zh-CN': '函数',
  'de-DE': 'Funktion',
};
import { LoadingSkeleton } from '@/components/feedback/loading-skeleton';
import { Container, PageHeader } from '@/components/ui';
import { Breadcrumbs } from '@/components/ui/breadcrumbs';
import { DecisionTracePanel, type DecisionTrace } from '@/components/policy/decision-trace-panel';
import { RuleSelector } from '@/components/policy/rule-selector';
import { extractErrorMessage } from '@/lib/api/error-envelope';
import { chooseDefaultRule, extractRuleSymbols } from '@/lib/aster/rules';
// P0-R2 (codex review Low #9): import 必须在顶部
import { detectCNLLanguage, isHighConfidence } from '@/lib/cnl-language-detector';

// Policy locale 直接采用 BCP-47 标准（与 quickDetectLanguage 返回值对齐）。
// P0-R Medium #8 修复：之前定义本地三元 type 'zh'|'de'|'en' + 三元映射，
// 与 src/lib/cnl-language-detector.ts 的 SupportedLocale = 'en-US'|'zh-CN'|'de-DE'
// 重复且不一致；任何 detector 改动需要同步维护两份。统一后所有 caller 使用
// BCP-47。
type PolicyLocale = 'en-US' | 'zh-CN' | 'de-DE';
type TypeKind = 'primitive' | 'struct' | 'enum' | 'list' | 'map' | 'option' | 'result' | 'function' | 'unknown';

const LEXICON_MAP: Record<PolicyLocale, Lexicon> = {
  'zh-CN': ZH_CN,
  'de-DE': DE_DE,
  'en-US': EN_US,
};

interface ExecutionResult {
  executionId: string;
  success: boolean;
  output?: {
    matchedRules: string[];
    actions: string[];
    approved: boolean;
    /** 计算/值输出（如 greet → "Hello, John Smith!"）；决策策略可无。 */
    result?: unknown;
    metadata?: {
      /** 'indeterminate'：执行成功但无 allow/deny 语义（如返回纯文本值），既非批准亦非真实拒绝。 */
      decision?: 'indeterminate';
      /** Verdict 结果码（ADR 0041 §4）：REQUIRE_APPROVAL/ESCALATE 为待人工处置态。 */
      outcome?: string;
    };
  };
  decisionTrace?: DecisionTrace;
  error?: string;
  durationMs: number;
  executedFunction?: string;
  diagnostics?: ExecutionDiagnostic[];
}

/** 待人工处置的 Verdict 结果码 → 文案 key；非待处置返回 null。 */
function pendingOutcomeKey(outcome: string | undefined): 'require_approval' | 'escalate' | null {
  if (outcome === 'REQUIRE_APPROVAL') return 'require_approval';
  if (outcome === 'ESCALATE') return 'escalate';
  return null;
}

const PENDING_BADGE_CLASS = 'inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-sm font-medium text-amber-800';

interface ExecutionDiagnostic {
  code: string;
  message: string;
  candidates?: string[];
}

// Use SchemaResult as PolicySchema (same interface)
type PolicySchema = SchemaResult;

type InputMode = 'form' | 'json';

// detectPolicyLocale 现在使用完整 detectCNLLanguage（带 confidence）。
// P0-R2 (codex review Medium #5): 之前丢弃 confidence 直接返回 detected
// locale，低置信度/混合语言会被强制归类（默认 tie-break 偏 en-US），可能
// 给 AI Explain 错误的 prompt locale。修复后：低于阈值时不再 trust
// detection，由调用方提供 page locale fallback。
function detectPolicyLocale(content: string, fallback: PolicyLocale): PolicyLocale {
  const result = detectCNLLanguage(content);
  return isHighConfidence(result) ? result.detected : fallback;
}

interface ExecutePolicyContentProps {
  policyId: string;
  locale: string;
}

// 从表单值构建命名上下文
function buildNamedContext(
  formValues: Record<string, Record<string, unknown>>,
  parameters: ParameterInfo[]
): Record<string, unknown> {
  const context: Record<string, unknown> = {};
  for (const param of parameters) {
    const value = formValues[param.name];
    if (value !== undefined) {
      context[param.name] = value;
    }
  }
  return context;
}

// 扩展字段信息（包含枚举变体，兼容未发布的 FieldInfo 类型）
type FieldInfoWithEnum = FieldInfo & { enumVariants?: string[] };
type ParameterInfoWithEnum = ParameterInfo & { enumVariants?: string[] };

// 初始化表单值（带自动生成的示例数据）
function initFormValuesWithSampleData(
  parameters: ParameterInfo[],
  lexicon?: Lexicon,
): Record<string, Record<string, unknown>> {
  const values: Record<string, Record<string, unknown>> = {};
  for (const param of parameters) {
    const p = param as ParameterInfoWithEnum;
    if (p.typeKind === 'struct' && p.fields) {
      const structValue: Record<string, unknown> = {};
      for (const field of p.fields) {
        const f = field as FieldInfoWithEnum;
        if (f.typeKind === 'enum' && f.enumVariants && f.enumVariants.length > 0) {
          structValue[f.name] = f.enumVariants[0];
        } else {
          structValue[f.name] = generateFieldValue(f.name, f.type, f.typeKind, lexicon);
        }
      }
      values[p.name] = structValue;
    } else if (p.typeKind === 'enum' && p.enumVariants && p.enumVariants.length > 0) {
      values[p.name] = p.enumVariants[0] as unknown as Record<string, unknown>;
    } else {
      values[p.name] = generateFieldValue(
        p.name,
        p.type,
        p.typeKind,
        lexicon,
      ) as Record<string, unknown>;
    }
  }
  return values;
}

export function ExecutePolicyContent({ policyId, locale }: ExecutePolicyContentProps) {
  const t = useTranslations('policies.execute');
  // Breadcrumb 文案复用 policies 命名空间已有键（policies.title=列表页名、
  // policies.executeAction=当前页短标签），避免新增 i18n 键。
  const tPolicies = useTranslations('policies');
  const [input, setInput] = useState('');
  const [result, setResult] = useState<ExecutionResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [policyName, setPolicyName] = useState('');
  const [policyLocale, setPolicyLocale] = useState<PolicyLocale>('en-US');
  const [selectedRule, setSelectedRule] = useState<string | null>(null);
  const [executionDiagnostics, setExecutionDiagnostics] = useState<ExecutionDiagnostic[]>([]);

  // P0-R2 (codex review High Medium #6): schemaError 结构化为
  // { messageKey, detail }。主文案走 i18n，detail 仅在折叠区显示，
  // 避免泄漏 HTTP 内部细节给客户。
  interface SchemaError {
    /** i18n key under namespace 'policies.execute' */
    messageKey: 'policy.fetch_failed' | 'policy.empty_content' | 'policy.schema_failed';
    /** 技术细节（HTTP 状态、异常消息等），仅在 details 折叠区显示 */
    detail?: string;
  }

  // 新增状态：动态表单
  const [inputMode, setInputMode] = useState<InputMode>('json');
  const [schema, setSchema] = useState<PolicySchema | null>(null);
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<SchemaError | null>(null);
  const [formValues, setFormValues] = useState<Record<string, Record<string, unknown>>>({});
  // 策略源码：用于提取规则符号（ruleSymbols）和按 locale 选词典。
  const [policyContent, setPolicyContent] = useState('');

  const ruleSymbols = useMemo(() => extractRuleSymbols(policyContent), [policyContent]);
  const ambiguousEntryDiagnostic = executionDiagnostics.find((diag) => diag.code === 'ENTRY_AMBIGUOUS');


  // 获取策略参数模式（本地编译，无需 API 调用）。
  // ★aliasSet：活跃版本冻结的关键词/运算符别名（kind→短语）。必须合并进 lexicon.aliases
  // 后再编译——否则含别名的源码（如 "+ => followed by" 写成 "Hello " followed by name）在
  // schema 提取阶段解析失败（Expected '.'），"生成示例" 不可用。与 useAsterCompiler / 执行端
  // 同口径（都靠 lexicon.aliases 归一）。
  const fetchSchema = useCallback((
    content: string,
    detectedLocale: PolicyLocale,
    aliasSet?: Record<string, readonly string[]> | null,
  ) => {
    if (!content) return;

    setSchemaLoading(true);
    setSchemaError(null);
    try {
      // 使用本地编译提取 schema，把别名合并进 lexicon（有别名时）。
      const baseLexicon = LEXICON_MAP[detectedLocale];
      const lexicon: Lexicon =
        aliasSet && Object.keys(aliasSet).length > 0
          ? {
              ...baseLexicon,
              aliases: {
                ...((baseLexicon as { aliases?: Record<string, readonly string[]> }).aliases ?? {}),
                ...aliasSet,
              },
            }
          : baseLexicon;
      const data = extractSchema(content, { lexicon });

      if (data.success && data.parameters && data.parameters.length > 0) {
        setSchema(data);
        // 初始化表单值（使用自动生成的示例数据，传入 lexicon 启用本地化）
        setFormValues(initFormValuesWithSampleData(data.parameters, lexicon));
        // 同时更新 JSON 输入区域
        const sampleInput = generateInputValues(data.parameters, lexicon);
        setInput(JSON.stringify(sampleInput, null, 2));
      } else if (!data.success && data.error) {
        // Schema extraction failed - display error and use default empty JSON
        console.warn('Schema extraction failed:', data.error);
        setSchemaError({ messageKey: 'policy.schema_failed', detail: data.error });
        setInput('{}');
      } else {
        // No parameters found - use default empty JSON
        setInput('{}');
      }
    } catch (err) {
      console.error('Failed to extract schema:', err);
      setSchemaError({
        messageKey: 'policy.schema_failed',
        detail: err instanceof Error ? err.message : 'Failed to extract schema',
      });
      setInput('{}');
    } finally {
      setSchemaLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch policy details including content. P0-R Medium #9 修复：
    // 之前 catch 块只 setInput('{}')，不通知用户——404 / 鉴权失败 / API
    // shape 变更都会让页面静默无内容，且 AI Explain 按钮静默消失。修复后
    // 显式设置 schemaError，让 UI 可见地报告失败原因。
    fetch(`/api/policies/${policyId}`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} fetching policy ${policyId}`);
        }
        return res.json();
      })
      .then((data) => {
        setPolicyName(data.name);
        setPolicyContent(data.content || '');
        // P0-R2: 低置信度检测时 fallback 到 page locale，避免给 AI Explain
        // 错误的 prompt locale
        const pageLocaleFallback: PolicyLocale =
          locale.startsWith('zh') ? 'zh-CN' : locale.startsWith('de') ? 'de-DE' : 'en-US';
        const detectedLocale = detectPolicyLocale(data.content || '', pageLocaleFallback);
        setPolicyLocale(detectedLocale);
        // 活跃版本冻结的 aliasSet（canonical JSON），合并进 lexicon 供 schema 提取。
        // 由后端精确返回 activeAliasSet（GET 已按 version===Policy.version 查），不从
        // 分页 versions 推断——rollback/set-default 可能让活跃版本不在最新 10 条内。
        // 损坏/缺失/形态异常视为无别名（不阻塞）。
        let aliasSet: Record<string, readonly string[]> | null = null;
        if (typeof data.activeAliasSet === 'string' && data.activeAliasSet) {
          try {
            const parsed = JSON.parse(data.activeAliasSet);
            // 防御性形态校验：必须是对象（非数组）且每个 value 是字符串数组（kind→短语[]）。
            // 任一项不符即整体视为无别名（不阻塞；aliasSet 来自服务端冻结 canonical JSON，
            // 此校验只兜异常/篡改）。
            if (
              parsed &&
              typeof parsed === 'object' &&
              !Array.isArray(parsed) &&
              Object.values(parsed).every(
                (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
              )
            ) {
              aliasSet = parsed as Record<string, readonly string[]>;
            }
          } catch {
            aliasSet = null;
          }
        }
        if (data.content) {
          fetchSchema(data.content, detectedLocale, aliasSet);
        } else {
          // 策略内容为空（合法的边界情况）—— 显式提示而非静默
          setInput('{}');
          setSchemaError({ messageKey: 'policy.empty_content' });
        }
      })
      .catch((err) => {
        // 显式失败：主文案走 i18n，detail 仅在折叠区显示（避免泄漏内部细节）
        const reason = err instanceof Error ? err.message : String(err);
        setSchemaError({ messageKey: 'policy.fetch_failed', detail: reason });
        setInput('{}');
      });
  }, [policyId, fetchSchema, locale]);

  useEffect(() => {
    // ruleSymbols 变化时重置默认规则（selectedRule 仍可被用户手动改），故意在 effect 内 set
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedRule(chooseDefaultRule(ruleSymbols));
  }, [ruleSymbols]);

  // 重新生成示例数据（使用检测到的策略语言生成本地化示例值）
  const regenerateSampleData = useCallback(() => {
    if (schema?.parameters) {
      const lexicon = LEXICON_MAP[policyLocale];
      setFormValues(initFormValuesWithSampleData(schema.parameters, lexicon));
      const sampleInput = generateInputValues(schema.parameters, lexicon);
      setInput(JSON.stringify(sampleInput, null, 2));
    }
  }, [schema, policyLocale]);

  // 更新表单字段值
  const updateFormField = (paramName: string, fieldName: string | null, value: unknown) => {
    setFormValues(prev => {
      const newValues = { ...prev };
      if (fieldName === null) {
        // 直接更新参数值（非结构体类型）
        newValues[paramName] = value as Record<string, unknown>;
      } else {
        // 更新结构体字段
        newValues[paramName] = {
          ...prev[paramName],
          [fieldName]: value,
        };
      }
      return newValues;
    });
  };

  const handleExecute = async (functionNameOverride?: string) => {
    const functionName = functionNameOverride ?? selectedRule;
    if (functionNameOverride) {
      setSelectedRule(functionNameOverride);
    }
    setIsLoading(true);
    setError('');
    setResult(null);
    setExecutionDiagnostics([]);

    try {
      let parsedInput: unknown;

      if (inputMode === 'form' && schema?.parameters) {
        // 从表单构建命名上下文
        parsedInput = buildNamedContext(formValues, schema.parameters);
      } else {
        // JSON 模式：解析输入
        parsedInput = JSON.parse(input);
      }

      // 使用已保存的策略：通过 policyId 执行
      const res = await fetch(`/api/policies/${policyId}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          input: parsedInput,
          ...(functionName ? { functionName } : {}),
        }),
      });

      const data = await res.json();
      setExecutionDiagnostics(Array.isArray(data.diagnostics) ? data.diagnostics : []);

      if (!res.ok) {
        // 优先显示详细消息，支持冻结和配额超限场景
        const errorMessage = data.message || extractErrorMessage(data) || t('executionFailed');
        setError(errorMessage);
        // 保存是否需要升级的标志
        if (data.upgrade || data.frozen) {
          setError(`${errorMessage}|UPGRADE`);
        }
        return;
      }

      setResult(data);
      setExecutionDiagnostics(Array.isArray(data.diagnostics) ? data.diagnostics : []);
    } catch (err) {
      if (err instanceof SyntaxError) {
        setError(t('invalidJson'));
      } else {
        setError(err instanceof Error ? err.message : t('executionFailed'));
      }
    } finally {
      setIsLoading(false);
    }
  };

  // 渲染单个表单字段
  const renderField = (
    paramName: string,
    fieldName: string | null,
    typeName: string,
    typeKind: TypeKind,
    value: unknown,
    enumVariants?: string[]
  ) => {
    const id = fieldName ? `${paramName}-${fieldName}` : paramName;
    const label = fieldName || paramName;

    // 枚举类型：渲染下拉选择框
    if (typeKind === 'enum' && enumVariants && enumVariants.length > 0) {
      return (
        <div key={id}>
          <label htmlFor={id} className="block text-sm font-semibold text-fg mb-2">
            {label} <span className="text-xs font-normal text-fg-subtle bg-bg-muted px-2 py-0.5 rounded">({typeName})</span>
          </label>
          <select
            id={id}
            value={String(value ?? enumVariants[0])}
            onChange={(e) => updateFormField(paramName, fieldName, e.target.value)}
            className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg shadow-sm transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none hover:border-gray-400 sm:text-sm"
          >
            {enumVariants.map((variant) => (
              <option key={variant} value={variant}>{variant}</option>
            ))}
          </select>
        </div>
      );
    }

    // 根据类型渲染不同的输入控件
    if (['bool', 'boolean', '布尔', 'wahrheitswert'].some(t => typeName.toLowerCase().includes(t))) {
      return (
        <div key={id} className="flex items-center gap-3 py-2">
          <input
            type="checkbox"
            id={id}
            checked={Boolean(value)}
            onChange={(e) => updateFormField(paramName, fieldName, e.target.checked)}
            className="h-5 w-5 rounded border-border-strong text-primary focus:ring-2 focus:ring-primary/20 cursor-pointer transition-colors"
          />
          <label htmlFor={id} className="text-sm font-medium text-fg cursor-pointer">
            {label}
          </label>
          <span className="text-xs text-fg-subtle bg-bg-muted px-2 py-0.5 rounded">({typeName})</span>
        </div>
      );
    }

    if (['int', 'integer', 'long', '整数', '长整数', 'ganzzahl', 'langzahl'].some(t => typeName.toLowerCase().includes(t))) {
      return (
        <div key={id}>
          <label htmlFor={id} className="block text-sm font-semibold text-fg mb-2">
            {label} <span className="text-xs font-normal text-fg-subtle bg-bg-muted px-2 py-0.5 rounded">({typeName})</span>
          </label>
          <input
            type="number"
            id={id}
            value={value as number ?? 0}
            onChange={(e) => updateFormField(paramName, fieldName, parseInt(e.target.value, 10) || 0)}
            className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg shadow-sm transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none hover:border-gray-400 sm:text-sm"
          />
        </div>
      );
    }

    if (['double', 'float', 'decimal', '小数', '浮点数', 'dezimal'].some(t => typeName.toLowerCase().includes(t))) {
      return (
        <div key={id}>
          <label htmlFor={id} className="block text-sm font-semibold text-fg mb-2">
            {label} <span className="text-xs font-normal text-fg-subtle bg-bg-muted px-2 py-0.5 rounded">({typeName})</span>
          </label>
          <input
            type="number"
            step="0.01"
            id={id}
            value={value as number ?? 0}
            onChange={(e) => updateFormField(paramName, fieldName, parseFloat(e.target.value) || 0)}
            className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg shadow-sm transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none hover:border-gray-400 sm:text-sm"
          />
        </div>
      );
    }

    // 默认：文本输入
    return (
      <div key={id}>
        <label htmlFor={id} className="block text-sm font-semibold text-fg mb-2">
          {label} <span className="text-xs font-normal text-fg-subtle bg-bg-muted px-2 py-0.5 rounded">({typeName})</span>
        </label>
        <input
          type="text"
          id={id}
          value={String(value ?? '')}
          onChange={(e) => updateFormField(paramName, fieldName, e.target.value)}
          className="block w-full rounded-lg border border-border-strong bg-bg px-4 py-2.5 text-fg placeholder-gray-400 shadow-sm transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none hover:border-gray-400 sm:text-sm"
        />
      </div>
    );
  };

  // 渲染参数表单
  const renderParameterForm = (param: ParameterInfo) => {
    const paramValue = formValues[param.name];

    if (param.typeKind === 'struct' && param.fields && param.fields.length > 0) {
      // 结构体类型：渲染字段组
      return (
        <div key={param.name} className="bg-bg-subtle border border-border rounded-xl p-5 mb-4">
          <h4 className="text-sm font-bold text-fg mb-4 flex items-center">
            <span className="w-2 h-2 bg-primary rounded-full mr-2" />
            {param.name}
            <span className="ml-2 text-xs font-normal text-fg-subtle bg-bg px-2 py-0.5 rounded border border-border">
              {param.type}
            </span>
          </h4>
          <div className="space-y-4 bg-bg rounded-lg p-4 border border-border">
            {param.fields.map((field) =>
              renderField(
                param.name,
                field.name,
                field.type,
                field.typeKind,
                (paramValue as Record<string, unknown>)?.[field.name],
                (field as FieldInfoWithEnum).enumVariants
              )
            )}
          </div>
        </div>
      );
    }

    // 基本类型或枚举：直接渲染
    return (
      <div key={param.name} className="mb-4">
        {renderField(param.name, null, param.type, param.typeKind, paramValue, (param as ParameterInfoWithEnum).enumVariants)}
      </div>
    );
  };

  return (
    <Container size="xl" className="py-6 sm:py-10">
      {/* Deep 页：保留 Breadcrumbs（Policies → 策略名 → 当前执行页）。
          原手抄的返回箭头 <Link> 由 breadcrumb 第二项（指向策略详情）替代。 */}
      <PageHeader
        breadcrumbs={
          <Breadcrumbs
            items={[
              { label: tPolicies('title'), href: '/policies' },
              { label: policyName || 'Policy', href: `/policies/${policyId}` },
              { label: tPolicies('executeAction') },
            ]}
          />
        }
        title={t('title', { name: policyName || 'Policy' })}
        subtitle={t('subtitle')}
        className="mb-6"
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Input Panel */}
        <div className="bg-bg shadow-lg sm:rounded-xl border border-border">
          <div className="px-6 py-6 sm:p-8">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-fg">{t('input')}</h3>
              <div className="flex items-center space-x-3">
                {/* Mode Toggle */}
                {schema?.parameters && schema.parameters.length > 0 && (
                  <div className="flex rounded-lg bg-bg-muted p-1">
                    <button
                      onClick={() => setInputMode('form')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                        inputMode === 'form'
                          ? 'bg-bg text-fg shadow-sm'
                          : 'text-fg-muted hover:text-fg'
                      }`}
                    >
                      Form
                    </button>
                    <button
                      onClick={() => setInputMode('json')}
                      className={`px-3 py-1 text-xs font-medium rounded-md transition-colors ${
                        inputMode === 'json'
                          ? 'bg-bg text-fg shadow-sm'
                          : 'text-fg-muted hover:text-fg'
                      }`}
                    >
                      JSON
                    </button>
                  </div>
                )}
                {inputMode === 'form' && schema?.parameters && (
                  <button
                    onClick={regenerateSampleData}
                    className="text-xs text-primary hover:text-primary font-medium flex items-center gap-1"
                    title={t('generateSampleData')}
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
                    </svg>
                    {t('generateSampleData')}
                  </button>
                )}
                {inputMode === 'json' && (
                  <button
                    onClick={regenerateSampleData}
                    className="text-xs text-primary hover:text-primary font-medium flex items-center gap-1"
                    title={t('generateSampleData')}
                  >
                    <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M15.312 11.424a5.5 5.5 0 01-9.201 2.466l-.312-.311h2.433a.75.75 0 000-1.5H3.989a.75.75 0 00-.75.75v4.242a.75.75 0 001.5 0v-2.43l.31.31a7 7 0 0011.712-3.138.75.75 0 00-1.449-.39zm1.23-3.723a.75.75 0 00.219-.53V2.929a.75.75 0 00-1.5 0V5.36l-.31-.31A7 7 0 003.239 8.188a.75.75 0 101.448.389A5.5 5.5 0 0113.89 6.11l.311.31h-2.432a.75.75 0 000 1.5h4.243a.75.75 0 00.53-.219z" clipRule="evenodd" />
                    </svg>
                    {t('generateSampleData')}
                  </button>
                )}
              </div>
            </div>

            {/* Schema Loading Indicator */}
            {schemaLoading && (
              <div aria-live="polite" className="py-4">
                <LoadingSkeleton lines={3} />
              </div>
            )}

            {/* Schema Error Display
                 P0-R2 (codex review Medium #8): 主文案走 i18n（schemaError.messageKey 映射到
                 翻译键），detail 仅在折叠区作为开发者参考显示。避免裸 string
                 渲染暴露 HTTP 内部细节给客户。 */}
            {schemaError && !schemaLoading && (
              <div className="mb-4 rounded-lg bg-amber-50 border border-amber-200 p-4">
                <div className="flex">
                  <svg className="h-5 w-5 text-amber-400 flex-shrink-0" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                  <div className="ml-3">
                    <h4 className="text-sm font-medium text-amber-800">
                      {schemaError.messageKey === 'policy.fetch_failed'
                        ? t('policyFetchFailed')
                        : schemaError.messageKey === 'policy.empty_content'
                          ? t('policyEmptyContent')
                          : t('schemaExtractionFailed')}
                    </h4>
                    <p className="mt-1 text-xs text-amber-700">
                      {t('schemaExtractionFailedHint')}
                    </p>
                    {schemaError.detail && (
                      <details className="mt-2">
                        <summary className="text-xs text-amber-600 cursor-pointer hover:text-amber-800">
                          {t('viewDetails')}
                        </summary>
                        <pre className="mt-2 text-xs text-amber-700 bg-amber-100 p-2 rounded overflow-x-auto whitespace-pre-wrap">
                          {schemaError.detail}
                        </pre>
                      </details>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* Form Mode */}
            {inputMode === 'form' && schema?.parameters && schema.parameters.length > 0 && !schemaLoading && (
              <div className="space-y-4 max-h-[clamp(300px,60vh,600px)] overflow-y-auto pr-2">
                {schema.functionName && (
                  <div className="text-sm text-fg-muted mb-2">
                    {FUNCTION_LABEL[policyLocale] ?? 'Function'}: <span className="font-mono text-fg">{schema.functionName}</span>
                  </div>
                )}
                {schema.parameters.map((param) => renderParameterForm(param))}
              </div>
            )}

            {/* JSON Mode */}
            {inputMode === 'json' && (
              <textarea
                id="jsonInput"
                name="jsonInput"
                aria-label={t('input')}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                rows={12}
                className="block w-full rounded-lg border border-border-strong bg-gray-900 px-4 py-3 text-gray-100 placeholder-gray-500 shadow-sm font-mono text-sm leading-relaxed transition-all duration-200 focus:border-primary focus:ring-2 focus:ring-primary/20 focus:outline-none"
                placeholder={t('inputPlaceholder')}
              />
            )}

            <div className="mt-4">
              <RuleSelector
                rules={ruleSymbols}
                value={selectedRule}
                onChange={setSelectedRule}
              />
            </div>

            <button
              onClick={() => handleExecute()}
              disabled={isLoading}
              className="mt-4 w-full inline-flex justify-center items-center rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition-all duration-200 hover:bg-primary-hover focus:ring-2 focus:ring-primary/20 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? (
                <>
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                  </svg>
                  {t('executing')}
                </>
              ) : (
                t('executeButton')
              )}
            </button>
          </div>
        </div>

        {/* Result Panel */}
        <div className="bg-bg shadow-lg sm:rounded-xl border border-border">
          <div className="px-6 py-6 sm:p-8">
            <h3 className="text-lg font-semibold text-fg mb-4">{t('result')}</h3>

            {error && (() => {
              const needsUpgrade = error.includes('|UPGRADE');
              const displayError = error.replace('|UPGRADE', '');
              return (
                <div className="rounded-lg bg-red-50 p-4">
                  <div className="flex">
                    <svg className="h-5 w-5 text-red-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                    </svg>
                    <div className="ml-3">
                      <p className="text-sm text-red-700">{displayError}</p>
                      {needsUpgrade && CLIENT_CAPABILITIES.billing && (
                        <Link href={`/${locale}/billing`} className="mt-1 block text-sm font-medium text-red-700 underline">
                          {t('upgradePlan')}
                        </Link>
                      )}
                    </div>
                  </div>
                </div>
              );
            })()}

            {ambiguousEntryDiagnostic?.candidates && ambiguousEntryDiagnostic.candidates.length > 0 && (
              <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-4 dark:border-amber-900/60 dark:bg-amber-950/30">
                <div className="flex gap-3">
                  <svg className="h-5 w-5 shrink-0 text-amber-500" viewBox="0 0 20 20" fill="currentColor">
                    <path fillRule="evenodd" d="M8.485 2.495c.673-1.167 2.357-1.167 3.03 0l6.28 10.875c.673 1.167-.17 2.625-1.516 2.625H3.72c-1.347 0-2.189-1.458-1.515-2.625L8.485 2.495zM10 5a.75.75 0 01.75.75v3.5a.75.75 0 01-1.5 0v-3.5A.75.75 0 0110 5zm0 9a1 1 0 100-2 1 1 0 000 2z" clipRule="evenodd" />
                  </svg>
                  <div>
                    <h4 className="text-sm font-semibold text-amber-900 dark:text-amber-100">
                      {t('entryAmbiguousTitle')}
                    </h4>
                    <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
                      {ambiguousEntryDiagnostic.message || t('entryAmbiguousBody')}
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {ambiguousEntryDiagnostic.candidates.map((candidate) => (
                        <button
                          key={candidate}
                          type="button"
                          onClick={() => handleExecute(candidate)}
                          disabled={isLoading}
                          className="rounded-md border border-amber-300 bg-bg px-3 py-1.5 text-xs font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-700 dark:bg-gray-900 dark:text-amber-100 dark:hover:bg-amber-900/30"
                        >
                          {candidate}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}

            {result && (
              <div className="space-y-4">
                {/* Status —— indeterminate（值/计算输出策略，执行成功但无 allow/deny 语义）
                    显示中性「已计算」而非红色「失败」，避免把正常运行的值输出策略误标为失败。 */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-fg-muted">{t('status')}</span>
                  {result.success ? (
                    <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-sm font-medium text-green-800">
                      {t('success')}
                    </span>
                  ) : pendingOutcomeKey(result.output?.metadata?.outcome) ? (
                    // 需人工批准 / 升级：待处置，琥珀色而非红色「失败」。
                    <span className={PENDING_BADGE_CLASS}>
                      {t(pendingOutcomeKey(result.output?.metadata?.outcome)!)}
                    </span>
                  ) : result.output?.metadata?.decision === 'indeterminate' ? (
                    <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-sm font-medium text-blue-800">
                      {t('computed')}
                    </span>
                  ) : (
                    <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-sm font-medium text-red-800">
                      {t('failed')}
                    </span>
                  )}
                </div>

                {/* Duration */}
                <div className="flex items-center justify-between">
                  <span className="text-sm text-fg-muted">{t('duration')}</span>
                  <span className="text-sm font-medium text-fg">{result.durationMs}ms</span>
                </div>

                {result.executedFunction && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-fg-muted">{t('executedRule')}</span>
                    <span className="font-mono text-sm font-medium text-fg">{result.executedFunction}</span>
                  </div>
                )}

                {/* Decision —— indeterminate 显示中性「无决策（值输出）」而非红色「拒绝」：
                    值/计算输出策略没有 allow/deny 语义，标红拒绝会误导。 */}
                {result.output && (
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-fg-muted">{t('decision')}</span>
                    {pendingOutcomeKey(result.output.metadata?.outcome) ? (
                      <span className={PENDING_BADGE_CLASS}>
                        {t(pendingOutcomeKey(result.output.metadata?.outcome)!)}
                      </span>
                    ) : result.output.metadata?.decision === 'indeterminate' ? (
                      <span className="inline-flex items-center rounded-full bg-blue-100 px-2.5 py-0.5 text-sm font-medium text-blue-800">
                        {t('noDecision')}
                      </span>
                    ) : result.output.approved ? (
                      <span className="inline-flex items-center rounded-full bg-green-100 px-2.5 py-0.5 text-sm font-medium text-green-800">
                        {t('approved')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-sm font-medium text-red-800">
                        {t('rejected')}
                      </span>
                    )}
                  </div>
                )}

                {/* 计算值输出（indeterminate=值/计算策略）：突出展示 result，
                    让 greet → "Hello, John Smith!" 这类结果可见，而非只在 raw output 里。 */}
                {result.output?.metadata?.decision === 'indeterminate' &&
                  result.output?.result !== undefined &&
                  result.output?.result !== null && (
                    <div>
                      <span className="text-sm font-medium text-fg">{t('result')}</span>
                      <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-bg-subtle px-3 py-2 text-sm text-fg">
                        {typeof result.output.result === 'string'
                          ? result.output.result
                          : JSON.stringify(result.output.result, null, 2)}
                      </pre>
                    </div>
                  )}

                {/* Matched Rules */}
                {result.output?.matchedRules && result.output.matchedRules.length > 0 && (
                  <div>
                    <span className="text-sm font-medium text-fg">{t('matchedRules')}</span>
                    <ul className="mt-2 space-y-1">
                      {result.output.matchedRules.map((rule, i) => (
                        <li key={i} className="text-sm text-fg-muted flex items-center">
                          <svg className="h-4 w-4 text-green-500 mr-2" viewBox="0 0 20 20" fill="currentColor">
                            <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 01.143 1.052l-8 10.5a.75.75 0 01-1.127.075l-4.5-4.5a.75.75 0 011.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 011.05-.143z" clipRule="evenodd" />
                          </svg>
                          {rule}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Actions */}
                {result.output?.actions && result.output.actions.length > 0 && (
                  <div>
                    <span className="text-sm font-medium text-fg">{t('actions')}</span>
                    <ul className="mt-2 space-y-1">
                      {result.output.actions.map((action, i) => (
                        <li key={i} className="text-sm text-fg-muted bg-bg-subtle px-2 py-1 rounded">
                          {action}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Error */}
                {result.error && (
                  <div className="rounded-lg bg-red-50 p-4">
                    <p className="text-sm text-red-700">{result.error}</p>
                  </div>
                )}

                {/* Raw Output */}
                <details className="mt-4">
                  <summary className="text-sm text-fg-muted cursor-pointer hover:text-fg">
                    {t('viewRawOutput')}
                  </summary>
                  <pre className="mt-2 bg-gray-900 text-gray-100 p-4 rounded-lg overflow-x-auto text-xs">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </details>
              </div>
            )}

            {!result && !error && (
              <div className="text-center py-12 text-fg-muted">
                <svg className="mx-auto h-12 w-12 text-fg-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
                <p className="mt-2">{t('emptyState')}</p>
              </div>
            )}
          </div>
        </div>
        {result?.decisionTrace && (
          <DecisionTracePanel trace={result.decisionTrace} />
        )}
      </div>
    </Container>
  );
}
