/**
 * 编辑器里「这条策略用哪种 CNL 语言」（#627）。
 *
 * 状态栏的 CNL 标签、别名面板的规范拼写列、别名占用集、编辑器词法/补全、保存请求的 locale
 * 都以它为准——它是策略本身的语言，与界面语言无关（德语界面编辑英文策略应显示 EN-US）。
 *
 * 判定顺序与执行端相同，统一由 @/lib/policy-locale-priority 提供：
 * - 编辑：服务端按活跃版本 resolveStoredVersionLocale 解析后下发（记录的编译 locale →
 *   快照 locale → 源码识别），编辑器原样使用，不再在浏览器里重新猜。
 * - 新建：没有记录值；源码为空时按界面语言，否则按源码识别。
 * 用户显式「切换策略语言」或使用语言转换后，以用户选择为准（覆盖值）。
 */

import { detectCNLLanguage, isHighConfidence } from '@/lib/cnl-language-detector';
import { normalizeCnlLocale } from '@/lib/cnl-locale';
import { choosePolicyLocale } from '@/lib/policy-locale-priority';
import { normalizeLocale } from '@/data/policy-examples';

export interface EditorCnlLocaleInput {
  /** 用户显式选定的语言（切换语言 / 语言转换后）；没有则为 null。 */
  chosen: string | null;
  /** 服务端按活跃版本解析出的策略语言（编辑）；新建为 null。 */
  resolved: string | null | undefined;
  /** 编辑器当前源码。 */
  content: string;
  /** 界面语言（如 'de'），只用于新建空策略。 */
  uiLocale: string;
}

/** 规范 BCP-47 标签；不受支持的值原样返回（不在这里擅自改成别的语言）。 */
function canonical(locale: string): string {
  return normalizeCnlLocale(locale) ?? locale;
}

/** 编辑器使用的策略 CNL 语言（规范标签）。 */
export function resolveEditorCnlLocale({ chosen, resolved, content, uiLocale }: EditorCnlLocaleInput): string {
  if (chosen) return canonical(chosen);
  return canonical(
    choosePolicyLocale({
      recorded: resolved,
      source: content,
      detect: (source) => detectCNLLanguage(source).detected,
      emptySourceFallback: normalizeLocale(uiLocale),
    }),
  );
}

/**
 * 源码高置信识别出的语言与策略语言不一致时返回识别结果，否则 null。
 * 编辑器据此提示「切换策略语言」，但不会自动切换：记录值是编译与执行所用的事实。
 */
export function detectLocaleMismatch(policyLocale: string, content: string): string | null {
  const detection = detectCNLLanguage(content);
  if (!isHighConfidence(detection)) return null;
  return detection.detected === canonical(policyLocale) ? null : detection.detected;
}
