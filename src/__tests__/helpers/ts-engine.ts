/**
 * 测试用执行端替身：用 aster-lang-ts 真引擎模拟 aster-api evaluate-source 的语义——
 * 按 locale 选 lexicon（并入关键词别名），把传入的领域词汇注册为用户词汇域后编译，
 * 用收到的 context 求值。这样路由测试验证的是「映射后的输入在真实规范化下能否命中字段」，
 * 而不是替身自己的假设。
 */
import { compile, evaluate } from '@aster-cloud/aster-lang-ts/browser';
import { getLexicon, initBuiltinVocabularies, vocabularyRegistry, type DomainVocabulary, type Lexicon } from '@/lib/aster-lexicon';
import { USER_VOCABULARY_DOMAIN } from '@/lib/domain-vocabulary-scope';

let tenantSeq = 0;

export interface TsEngineOptions {
  locale?: string;
  functionName?: string;
  vocabulary?: Record<string, unknown>;
  aliasSet?: Record<string, string[]> | null;
}

function lexiconFor(options: TsEngineOptions): Lexicon {
  const base = getLexicon(options.locale ?? 'en-US');
  if (!options.aliasSet) return base;
  const baseAliases = (base as { aliases?: Record<string, readonly string[]> }).aliases ?? {};
  return { ...base, aliases: { ...baseAliases, ...options.aliasSet } } as Lexicon;
}

export async function evaluateWithTsEngine(source: string, context: unknown, options: TsEngineOptions = {}) {
  initBuiltinVocabularies();
  const tenantId = `ts-engine-${++tenantSeq}`;
  if (options.vocabulary) {
    vocabularyRegistry.registerCustom(tenantId, { ...(options.vocabulary as unknown as DomainVocabulary), id: USER_VOCABULARY_DOMAIN });
  }
  const compiled = compile(source, {
    lexicon: lexiconFor(options),
    ...(options.vocabulary ? { domain: USER_VOCABULARY_DOMAIN, tenantId } : {}),
  } as Parameters<typeof compile>[1]);
  if (!compiled.core) {
    return { result: null, executionTimeMs: 1, error: `compile failed: ${JSON.stringify((compiled as { diagnostics?: unknown }).diagnostics ?? null)}` };
  }
  const decls = (compiled.core as unknown as { decls: ReadonlyArray<{ kind: string; name: string }> }).decls;
  const functionName = options.functionName ?? decls.find((d) => d.kind === 'Func')?.name ?? '';
  const run = evaluate(compiled.core, functionName, context as Record<string, unknown>);
  return { result: run.value ?? null, executionTimeMs: 1, error: run.error ? String(run.error) : null };
}
