/**
 * 源码是否声明了治理档案（ADR 0046 §2）：用于编译检查缺席时决定能否放行保存。
 *
 * 刻意保守：误判为「已声明」只会在编译服务不可用期间拒绝保存（503 可重试），漏判则会放过
 * E705/E706。因此不要求位置，只要在字符串字面量与注释之外出现 PROFILE 词、后接字符串字面量即算声明。
 */

/**
 * PROFILE 记号的本地化用词，取自 ADR 0046 §9.1 最终用词表（en / zh / de / hi）。
 * 已安装的 aster-lang-ts 词表尚无 PROFILE 记号，故集中维护于此。
 */
const PROFILE_KEYWORDS: readonly string[] = ['Profile', '档案', 'Profil', 'प्रोफ़ाइल'].map((w) =>
  w.normalize('NFC'),
);

// 字符串字面量的开闭引号：ASCII 双引号、zh 词表的直角引号、弯引号
const STRING_CLOSERS: Readonly<Record<string, string>> = { '"': '"', '「': '」', '“': '”' };

// 词边界取「前后都不是字母、数字、组合附加符或下划线」，覆盖无空格分词的 zh 与带附加符的 hi
const WORD_CHAR = '[\\p{L}\\p{N}\\p{M}_]';
const DECLARATION = new RegExp(
  `(?<!${WORD_CHAR})(?:${PROFILE_KEYWORDS.join('|')})(?!${WORD_CHAR})\\s*""`,
  'u',
);

/** 跳过字符串字面量（支持反斜杠转义，不跨行），返回闭引号之后的位置。 */
function skipString(text: string, start: number, closer: string): number {
  let i = start;
  while (i < text.length && text[i] !== closer && text[i] !== '\n') {
    i += text[i] === '\\' ? 2 : 1;
  }
  return i + 1;
}

/** 跳到行尾（保留换行符本身）。 */
function skipLine(text: string, start: number): number {
  const newline = text.indexOf('\n', start);
  return newline === -1 ? text.length : newline;
}

/** 删去 `#` 与 `//` 注释，并把每个字符串字面量替换为空字面量 `""`。 */
function maskCommentsAndStrings(text: string): string {
  let masked = '';
  let i = 0;
  while (i < text.length) {
    const closer = STRING_CLOSERS[text[i]];
    if (closer) {
      i = skipString(text, i + 1, closer);
      masked += '""';
    } else if (text[i] === '#' || text.startsWith('//', i)) {
      i = skipLine(text, i);
    } else {
      masked += text[i];
      i += 1;
    }
  }
  return masked;
}

export function declaresProfile(source: string): boolean {
  return DECLARATION.test(maskCommentsAndStrings(source.normalize('NFC')));
}
