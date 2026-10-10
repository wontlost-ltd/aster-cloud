/**
 * 源码是否声明了治理档案（ADR 0046 §2）：Module 行之后紧跟一行 `<PROFILE 词> "<id>".`。
 *
 * 只做行级识别，不解析源码：用于编译检查缺席时决定能否放行保存，不判定档案是否合法。
 */

/**
 * PROFILE 记号的本地化用词，取自 ADR 0046 §9.1 最终用词表（en / zh / de / hi）。
 * 已安装的 aster-lang-ts 词表尚无 PROFILE 记号，故集中维护于此，供各处共用。
 */
export const PROFILE_KEYWORDS: readonly string[] = ['Profile', '档案', 'Profil', 'प्रोफ़ाइल'].map((w) =>
  w.normalize('NFC'),
);

// 引号含 zh 词表的直角引号；句末含 en/de 的 `.`、zh 的 `。`、hi 的 `।`
const PROFILE_LINE = new RegExp(
  `^(?:${PROFILE_KEYWORDS.join('|')})\\s*["「“][^"」”]*["」”]\\s*[.。।]$`,
  'u',
);

function isSignificant(line: string): boolean {
  return line !== '' && !line.startsWith('//') && !line.startsWith('#');
}

/** 第一条有效行视为 Module 行，第二条有效行若是档案声明即返回 true。 */
export function declaresProfile(source: string): boolean {
  const lines = source
    .normalize('NFC')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(isSignificant);
  return lines.length >= 2 && PROFILE_LINE.test(lines[1]);
}
