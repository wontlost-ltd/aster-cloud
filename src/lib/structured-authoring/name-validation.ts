/**
 * 模型标签页的名字校验（ADR 0058 §8.3）：用 aster-lang-ts 自己的规范化器与词法器判定，
 * 候选名必须恰好是一个标识符 token，与编译器对源码的切分口径一致。
 *
 * 结构体 / 类型别名名：解析器接受 IDENT 与 TYPE_IDENT（`Define person with …` 亦可）。
 * 字段名：解析器只接受 IDENT（拉丁语言里大写起首会被词法器归为 TYPE_IDENT）。
 */
import { canonicalize, lex, TokenKind, type Lexicon } from '@aster-cloud/aster-lang-ts/browser';

type IdentifierKind = typeof TokenKind.IDENT | typeof TokenKind.TYPE_IDENT;

function isSingleToken(lexicon: Lexicon, raw: string, accepted: readonly IdentifierKind[]): boolean {
  const name = raw.trim();
  if (name.length === 0) return false;
  try {
    const tokens = lex(canonicalize(name, lexicon), lexicon);
    // [标识符, EOF]，且原文未被规范化改写
    const [head, end, ...rest] = tokens;
    return (
      rest.length === 0 &&
      end?.kind === TokenKind.EOF &&
      head !== undefined &&
      accepted.includes(head.kind as IdentifierKind) &&
      head.value === name
    );
  } catch {
    return false;
  }
}

export const isValidTypeName = (lexicon: Lexicon, name: string): boolean =>
  isSingleToken(lexicon, name, [TokenKind.IDENT, TokenKind.TYPE_IDENT]);

export const isValidFieldName = (lexicon: Lexicon, name: string): boolean =>
  isSingleToken(lexicon, name, [TokenKind.IDENT]);
