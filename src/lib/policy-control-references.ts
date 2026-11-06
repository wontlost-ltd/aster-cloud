/**
 * 从策略版本源码取出规则经 `@control("…")`（ADR 0039 §3）挂接的控制键（#739）。
 *
 * 为什么读源码而不是 Core IR 或执行记录：cloud 的 PolicyVersion 只存源码（无 IR 列），
 * 保存时的编译结果不落库；Execution.controls 只在策略被执行过时才有，且只反映被执行的那条规则。
 * 影响分析要回答「哪些策略的哪些版本引用了这个控制项」，源码是编译器读的同一份输入，也是唯一覆盖
 * 全部版本与全部规则的来源。
 *
 * 口径与 policy-profile-declaration 一致：注释（`#`、`//`）与普通字符串字面量之外出现的
 * `@control(<字符串字面量>)` 才算引用；注解名在四种词表里都是字面量 `control`（不本地化）。
 */

// 字符串字面量的开闭引号：ASCII 双引号、zh 词表的直角引号、弯引号
const STRING_CLOSERS: Readonly<Record<string, string>> = { '"': '"', '「': '」', '“': '”' };

const ANNOTATION = '@control';

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

function skipSpaces(text: string, start: number): number {
  let i = start;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  return i;
}

/**
 * 在 `@control` 之后尝试读取 `( "<key>" )`；成功返回键与结束位置，失败返回 null（扫描从注解名之后继续）。
 */
function readAnnotationArg(text: string, start: number): { key: string; end: number } | null {
  let i = skipSpaces(text, start);
  if (text[i] !== '(') return null;
  i = skipSpaces(text, i + 1);
  const closer = STRING_CLOSERS[text[i]];
  if (!closer) return null;
  const valueStart = i + 1;
  const end = skipString(text, valueStart, closer);
  if (text[end - 1] !== closer) return null;
  const key = text.slice(valueStart, end - 1).trim();
  return key ? { key, end } : null;
}

/** 源码引用的控制键，按首次出现顺序去重；无引用返回空数组。 */
export function extractControlReferences(source: string): string[] {
  const text = source.normalize('NFC');
  const keys: string[] = [];
  let i = 0;
  while (i < text.length) {
    const closer = STRING_CLOSERS[text[i]];
    if (closer) {
      i = skipString(text, i + 1, closer);
    } else if (text[i] === '#' || text.startsWith('//', i)) {
      i = skipLine(text, i);
    } else if (text.startsWith(ANNOTATION, i)) {
      const arg = readAnnotationArg(text, i + ANNOTATION.length);
      if (arg) {
        if (!keys.includes(arg.key)) keys.push(arg.key);
        i = arg.end;
      } else {
        i += ANNOTATION.length;
      }
    } else {
      i += 1;
    }
  }
  return keys;
}
