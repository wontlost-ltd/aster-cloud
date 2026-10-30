/**
 * 领域词汇解析诊断（ADR 0051 E800–E806）的附加信息：涉及的写法、候选词条，以及词汇页链接。
 *
 * ADR 0051 §1 要求歧义（E804/E805/E806）与未解析（E800–E803）诊断带出词条并能跳到词汇页修正。
 * 编辑器诊断带 data（引擎记录的模板参数 written / candidates）；服务端（aster-api）诊断只有 message，
 * 故回退从 message 解析：各语种模板都把写法放在首个单引号里、候选放在最后一个冒号之后，
 * 候选格式为引擎 formatCandidates 的 `规范名 (写法), …`。
 */

/** 与领域词汇相关的名称解析诊断码。 */
export const VOCABULARY_DIAGNOSTIC_CODES: ReadonlySet<string> = new Set([
  'E800', 'E801', 'E802', 'E803', 'E804', 'E805', 'E806',
]);

/** 诊断里与词汇相关的部分。 */
export interface VocabularyDiagnosticHelp {
  /** 源码中出问题的写法。 */
  written: string;
  /** 候选词条（`规范名 (写法)`），未解析类诊断为空。 */
  candidates: string[];
}

interface DiagnosticLike {
  code?: string | null;
  message?: string | null;
  data?: unknown;
}

function splitCandidates(text: string | undefined): string[] {
  return (text ?? '').split(/,\s*/).map((c) => c.trim()).filter(Boolean);
}

function candidatesFromMessage(message: string): string[] {
  const colon = Math.max(message.lastIndexOf(': '), message.lastIndexOf('：'));
  return colon < 0 ? [] : splitCandidates(message.slice(colon + 1));
}

/** 取诊断的词汇信息；不是词汇诊断或取不到写法时返回 null。 */
export function vocabularyDiagnosticHelp(diagnostic: DiagnosticLike): VocabularyDiagnosticHelp | null {
  if (!diagnostic.code || !VOCABULARY_DIAGNOSTIC_CODES.has(diagnostic.code)) return null;
  const data = (diagnostic.data && typeof diagnostic.data === 'object' ? diagnostic.data : {}) as Record<string, unknown>;
  const message = diagnostic.message ?? '';
  const written = typeof data.written === 'string' ? data.written : /'([^']+)'/.exec(message)?.[1];
  if (!written) return null;
  const candidates = typeof data.candidates === 'string'
    ? splitCandidates(data.candidates)
    : Array.isArray(data.candidates)
      ? data.candidates.filter((c): c is string => typeof c === 'string')
      : candidatesFromMessage(message);
  return { written, candidates };
}

/** 词汇页按写法过滤的路径（不带语言前缀，供 API 响应使用）。 */
function vocabularyPagePath(written: string): string {
  return `/domain-vocabularies?q=${encodeURIComponent(written)}`;
}

/** 界面内链接：带界面语言前缀。 */
export function vocabularyPageHref(uiLocale: string, written: string): string {
  return `/${uiLocale}${vocabularyPagePath(written)}`;
}

/** 服务端 compile_error 响应：给词汇诊断附 `vocabulary`（写法、候选、词汇页路径），其余原样返回。 */
export function withVocabularyHelp<T extends DiagnosticLike>(
  diagnostics: readonly T[],
): Array<T & { vocabulary?: VocabularyDiagnosticHelp & { href: string } }> {
  return diagnostics.map((d) => {
    const help = vocabularyDiagnosticHelp(d);
    return help ? { ...d, vocabulary: { ...help, href: vocabularyPagePath(help.written) } } : d;
  });
}
