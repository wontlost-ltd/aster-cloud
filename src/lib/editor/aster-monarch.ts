/**
 * 策略编辑器（Monaco）的 Monarch 着色规则：纯数据，monaco-policy-editor.tsx 的 registerAsterLanguage 用它
 * setMonarchTokensProvider，单测（src/__tests__/editor/aster-monarch.test.ts）用真实 Monaco tokenize 做快照。
 *
 * 名字转义（ADR 0064 §3.1、§6，ADR 0058 修订 3 E5/E7）：`` `x` `` 永远是名字。转义规则排在多词关键词与标识符规则
 * **之前**（Monarch 自上而下首个匹配即用），否则 `` `如果` `` 里的 `如果` 会被当作关键词着色；排在注释与字符串之后，
 * 注释与字符串里的反引号只是字符（N1c）。两个反引号以淡化的 `delimiter.escape` 着色，名字以 `identifier.escaped`
 * 着色（与普通标识符、领域词汇、关键词都不同）。未闭合或含非法字符的反引号不匹配，照旧落到 defaultToken。
 * 源码里没有反引号时，本规则不命中，着色与引入转义之前逐 token 相同。
 */
import type { languages } from 'monaco-editor';
import {
  buildMultiWordRules,
  extractVocabularyTerms,
  getKeywordsByCategory,
  type DomainVocabulary,
  type Lexicon,
} from '@/lib/aster-lexicon';

/** 名字转义的两个定界符与转义名的 token 类型（主题按此配色）。 */
export const ESCAPE_DELIMITER_TOKEN = 'delimiter.escape';
export const ESCAPED_NAME_TOKEN = 'identifier.escaped';

/**
 * 同一行内 `` ` `` + 名字 + `` ` ``。名字部分排除空白、`.`、各类引号、括号、标点与反引号（ADR 0064 N1a 的近似：
 * 着色只求不误判，合法性由编译器诊断）。
 */
const ESCAPED_NAME = /(`)([^`\s.,:;'"“”‘’「」『』«»()[\]{}，。：；、।॥]+)(`)/;

export function buildAsterMonarchLanguage(lexicon: Lexicon, vocabulary?: DomainVocabulary): languages.IMonarchLanguage {
  const keywords = getKeywordsByCategory(lexicon);
  // 多词关键词规则（从词表派生，见 buildMultiWordRules 的说明）。
  const multiWordRules = buildMultiWordRules(lexicon);
  // 提取领域词汇表术语
  const domainTerms = vocabulary ? extractVocabularyTerms(vocabulary) : [];

  return {
    // 关键词分类
    moduleKeywords: keywords.module,
    typeKeywords: keywords.type,
    functionKeywords: keywords.function,
    controlKeywords: keywords.control,
    variableKeywords: keywords.variable,
    booleanKeywords: keywords.boolean,
    operatorKeywords: keywords.operator,
    literalKeywords: keywords.literal,
    primitiveTypeKeywords: keywords.primitiveType,
    workflowKeywords: keywords.workflow,
    asyncKeywords: keywords.async,
    constraintKeywords: keywords.constraint,
    effectKeywords: keywords.effect,
    domainTerms,

    // Token 化规则
    tokenizer: {
      root: [
        // 注释 (// 或 # 开头)
        [/\/\/.*$/, 'comment'],
        [/#.*$/, 'comment'],

        // 字符串 (支持多种引号)
        [/"([^"\\]|\\.)*$/, 'string.invalid'], // 未闭合的字符串
        [/"/, 'string', '@string_double'],
        [/'([^'\\]|\\.)*$/, 'string.invalid'],
        [/'/, 'string', '@string_single'],
        [/「/, 'string', '@string_chinese'],

        // ★名字转义必须排在多词关键词与标识符规则**之前**（见文件头）。
        [ESCAPED_NAME, [ESCAPE_DELIMITER_TOKEN, ESCAPED_NAME_TOKEN, ESCAPE_DELIMITER_TOKEN]],

        // 数字
        [/\d+\.\d*/, 'number.float'],
        [/\.\d+/, 'number.float'],
        [/\d+/, 'number'],

        // ★多词关键词必须排在标识符规则**之前**：Monarch 自上而下首个匹配即用，
        //   标识符规则 [A-Za-z_…]+ 只吃到 "for" 就落 @default=identifier，
        //   排在后面的 /for each/ 永远轮不到（这是「英文/德文多词关键词从不高亮」的根因）。
        //   规则由 buildMultiWordRules 从词表**动态生成**（含长度降序，
        //   使 "integer divided by" 不被 "divided by" 抢先匹配），词表新增自动跟随。
        ...multiWordRules,

        // 标识符和关键词
        [
          /[a-zA-Z_一-龥ऀ-ॿ][\w一-龥ऀ-ॿ]*/,
          {
            cases: {
              '@moduleKeywords': 'keyword.module',
              '@typeKeywords': 'keyword.type',
              '@functionKeywords': 'keyword.function',
              '@controlKeywords': 'keyword.control',
              '@variableKeywords': 'keyword.variable',
              '@booleanKeywords': 'keyword.boolean',
              '@operatorKeywords': 'keyword.operator',
              '@literalKeywords': 'constant.language',
              '@primitiveTypeKeywords': 'type',
              '@workflowKeywords': 'keyword.workflow',
              '@asyncKeywords': 'keyword.async',
              '@constraintKeywords': 'keyword.constraint',
              '@effectKeywords': 'keyword.effect',
              '@domainTerms': 'variable.domain',
              '@default': 'identifier',
            },
          },
        ],

        // 运算符
        [/[+\-*/<>=!]+/, 'operator'],

        // 标点符号
        [/[{}()\[\]]/, 'delimiter.bracket'],
        [/[;,.:：。，、]/, 'delimiter'],

        // 空白
        [/\s+/, 'white'],
      ],

      // 双引号字符串
      string_double: [
        [/[^\\"]+/, 'string'],
        [/\\./, 'string.escape'],
        [/"/, 'string', '@pop'],
      ],

      // 单引号字符串
      string_single: [
        [/[^\\']+/, 'string'],
        [/\\./, 'string.escape'],
        [/'/, 'string', '@pop'],
      ],

      // 中文引号字符串
      string_chinese: [
        [/[^」]+/, 'string'],
        [/」/, 'string', '@pop'],
      ],
    },
  };
}
