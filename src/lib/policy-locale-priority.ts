/**
 * 策略 CNL 语言的唯一判定顺序（#627，纯函数，服务端与浏览器共用）。
 *
 * 执行（secure-execute）、审批冻结、编辑页（服务端解析后下发给编辑器）、新建策略的编辑器
 * 都经由这里，保证「编辑器显示/编译/保存的语言」与「执行时使用的语言」是同一个值：
 *
 *   1. 版本记录的编译 locale（envelope 反推，见 policy-version-locale.recordedCompileLocale）
 *   2. 版本冻结快照引用的 locale（唯一时）
 *   3. 仅在源码为空且调用方给了兜底值时（新建空策略）：界面语言对应的 CNL 语言
 *   4. 源码关键词识别
 *
 * 记录值是编译事实，不允许被源码识别静默覆盖；两者不一致时由编辑器提示用户显式切换
 * （见 policy-form/policy-cnl-locale.detectLocaleMismatch），只有显式切换或语言转换才改变保存的 locale。
 */

export interface PolicyLocaleEvidence {
  /** 版本记录的编译 locale；无版本或反推不出时为空。 */
  recorded?: string | null;
  /** 版本冻结快照引用的唯一 locale；无或不唯一时为空。 */
  snapshotLocale?: string | null;
  /** 源码。 */
  source: string;
  /** 源码语言识别（服务端与浏览器各用自己的识别器，二者只在没有记录值时才会被用到）。 */
  detect: (source: string) => string;
  /** 源码为空时的兜底（新建空策略按界面语言）；缺省时空源码也走识别。 */
  emptySourceFallback?: string | null;
}

export function choosePolicyLocale(evidence: PolicyLocaleEvidence): string {
  if (evidence.recorded) return evidence.recorded;
  if (evidence.snapshotLocale) return evidence.snapshotLocale;
  if (evidence.emptySourceFallback && evidence.source.trim() === '') return evidence.emptySourceFallback;
  return evidence.detect(evidence.source);
}
