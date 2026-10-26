/**
 * 编辑器里「这条策略用哪种 CNL 语言」的唯一判定（#627）。
 *
 * 状态栏的 CNL 标签、别名面板的规范拼写列、别名占用集、编辑器词法/补全、保存请求的 locale
 * 都以它为准——它描述的是策略本身的语言，与界面语言无关（德语界面编辑英文策略应显示 EN-US）。
 *
 * 判定顺序：
 *   1. 源码关键词高置信识别出的语言：源码就是策略本身，规范关键词列必须与它一致。
 *      已记录的 locale 不一定可靠——此前新建保存发送的是界面语言、编辑保存不带 locale（服务端
 *      按 en-US 记录），所以与高置信识别结果冲突时以源码为准。
 *   2. 已记录的 CNL locale（编辑：活跃版本保存时记录的编译 locale，见 policy-version-locale；
 *      经语言转换后为转换目标）。覆盖短源码、识别器不认识的语言（如 hi-IN）等低置信情形。
 *   3. 都没有（新建且源码为空/无法识别）：界面语言对应的 CNL 语言——空编辑器里插入的模板、
 *      语法参考都按界面语言给出，此时二者一致。
 */

import { detectCNLLanguage, isHighConfidence } from '@/lib/cnl-language-detector';
import { normalizeCnlLocale } from '@/lib/cnl-locale';
import { normalizeLocale } from '@/data/policy-examples';

export interface PolicyCnlLocaleInput {
  /** 已记录的策略 CNL 语言；新建策略为 null。 */
  recorded: string | null | undefined;
  /** 编辑器当前源码。 */
  content: string;
  /** 界面语言（如 'de'），仅作最后兜底。 */
  uiLocale: string;
}

/** 返回规范 BCP-47 标签（en-US / zh-CN / de-DE / hi-IN）。 */
export function resolvePolicyCnlLocale({ recorded, content, uiLocale }: PolicyCnlLocaleInput): string {
  const detection = detectCNLLanguage(content);
  if (isHighConfidence(detection)) return detection.detected;
  const recordedLocale = recorded ? normalizeCnlLocale(recorded) : null;
  return recordedLocale ?? normalizeLocale(uiLocale);
}
