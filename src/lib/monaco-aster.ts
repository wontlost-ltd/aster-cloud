/**
 * Monaco Editor Configuration for Aster CNL
 *
 * Registers the Aster CNL language with Monaco editor, providing:
 * - Language registration
 * - Basic syntax highlighting (Monarch tokenizer)
 * - Language configuration (brackets, comments, etc.)
 *
 * Note: Full LSP features (diagnostics, completion, hover) are provided
 * by the LSP server connection via useAsterLSP hook.
 */

import type { Monaco } from '@monaco-editor/react';
import {
  EN_US,
  ZH_CN,
  DE_DE,
  HI_IN,
  extractMonarchKeywords,
  extractPrimitiveTypeKeywordsAll,
} from './aster-lexicon';

/**
 * Extension types not yet present in {@link SemanticTokenKind} (Decimal,
 * Date, Duration, Money, etc). Will migrate to the lexicon registry once
 * lang-ts adds the corresponding token kinds; until then they live here
 * as a small Monaco-only addendum.
 *
 * Keep these grouped by locale + alphabetized so the diff stays clean
 * when the migration happens.
 */
const EXTRA_TYPE_KEYWORDS = [
  // English
  'Date',
  'DateTime',
  'Decimal',
  'Duration',
  'List',
  'Money',
  'Option',
  'Percentage',
  // Chinese
  '可选',
  '小数',  // duplicate of zh FLOAT_TYPE — but extra extension types may share base
  '时间',
  '时长',
  '日期',
  '列表',
  '百分比',
  '金额',
  // German
  'Dauer',
  'Datum',
  'Dezimal',
  'Geld',
  'Liste',
  'Optional',
  'Prozent',
  'Zeitstempel',
];

/**
 * Register Aster CNL language with Monaco editor
 */
export function registerAsterLanguage(monaco: Monaco): void {
  // Check if already registered
  const languages = monaco.languages.getLanguages();
  if (languages.some((lang: { id: string }) => lang.id === 'aster-cnl')) {
    return;
  }

  // Register the language
  monaco.languages.register({
    id: 'aster-cnl',
    extensions: ['.aster', '.cnl'],
    aliases: ['Aster CNL', 'aster', 'cnl'],
    mimetypes: ['text/x-aster-cnl'],
  });

  // 原语类型（Text/Int/Float/Bool）从 lang-ts 词法表派生 — 避免手写双源；
  // 扩展类型（Decimal/Date/Money 等）暂保留在 EXTRA_TYPE_KEYWORDS。
  const primitiveTypeKeywords = extractPrimitiveTypeKeywordsAll([EN_US, ZH_CN, DE_DE]);
  const typeKeywords = [...new Set([...primitiveTypeKeywords, ...EXTRA_TYPE_KEYWORDS])];

  // Tokens that should render as `type` MUST be removed from the generic
  // keyword sets — Monarch's `cases` evaluates in declaration order with
  // first-hit-wins. If Text/Int/Float/Bool stayed in `keywords`, the
  // `@keywords -> 'keyword'` arm would match first and the primitive types
  // would render as plain keywords instead of types (R-fix 7 codex finding).
  const typeKeywordSet = new Set(typeKeywords);
  const filterTypes = (xs: string[]) => xs.filter((w) => !typeKeywordSet.has(w));
  const keywords = filterTypes(extractMonarchKeywords(EN_US));
  const chineseKeywords = filterTypes(extractMonarchKeywords(ZH_CN));
  const germanKeywords = filterTypes(extractMonarchKeywords(DE_DE));
  const hindiKeywords = filterTypes(extractMonarchKeywords(HI_IN));

  // Set language configuration
  monaco.languages.setLanguageConfiguration('aster-cnl', {
    comments: {
      lineComment: '#',
    },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
      ['「', '」'], // Chinese quotes
      ['【', '】'], // Chinese brackets
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '「', close: '」' },
      { open: '【', close: '】' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '"', close: '"' },
      { open: "'", close: "'" },
      { open: '「', close: '」' },
    ],
    folding: {
      offSide: true, // Indent-based folding
    },
    indentationRules: {
      increaseIndentPattern: /:\s*$/,
      decreaseIndentPattern: /^\s*(Return|return|返回|gib\s+zurueck)\b/,
    },
  });

  // Set Monarch tokenizer for syntax highlighting
  monaco.languages.setMonarchTokensProvider('aster-cnl', {
    defaultToken: 'invalid',

    keywords,
    chineseKeywords,
    germanKeywords,
    hindiKeywords,

    // Type keywords come from the lexicon (primitives) + monaco-only extras.
    // Previous version hardcoded 27 string literals across 3 locales; that
    // doubled with lang-ts's lexicon and drifted on every locale change.
    typeKeywords,

    operators: [
      '=',
      '>',
      '<',
      '>=',
      '<=',
      '!=',
      '==',
      '+',
      '-',
      '*',
      '/',
      '%',
      ':',
      '.',
      ',',
      '，', // Chinese comma
      '。', // Chinese period
      '：', // Chinese colon
      '、', // Chinese enumeration comma
      '।', // Devanagari danda (Hindi statement-end)
      '॥', // Devanagari double danda
    ],

    symbols: /[=><!~?:&|+\-*\/\^%]+/,

    escapes: /\\(?:[abfnrtv\\"']|x[0-9A-Fa-f]{1,4}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8})/,

    tokenizer: {
      root: [
        // Identifiers and keywords
        [
          // \u0900-\u097f = Devanagari\uff08Hindi\uff09\uff1a\u8f85\u97f3/\u5143\u97f3\u7b26\u53f7/virama \u7ec4\u5408\u8bb0\u53f7\u90fd\u5728\u6b64\u533a\u6bb5\uff0c
          // \u5fc5\u987b\u7eb3\u5165\u6807\u8bc6\u7b26\u5b57\u7b26\u7c7b\uff0c\u5426\u5219\u5929\u57ce\u6587\u8bcd\u4f1a\u5728\u7ec4\u5408\u8bb0\u53f7\u5904\u788e\u88c2\u3002danda\u300c\u0964\u300d(U+0964)
          // \u662f\u53e5\u672b\u7b26\u4e0d\u662f\u5b57\u6bcd\uff0c\u4f46\u5b83\u843d\u5728\u6807\u70b9\u5206\u652f\uff08@symbols / \u4e0b\u65b9\u89c4\u5219\uff09\u5904\u7406\uff0c\u4e0d\u5728\u6b64\u7c7b\u3002
          /[a-zA-Z_\u4e00-\u9fa5\u00C0-\u024F\u0900-\u0963\u0966-\u097f][\w\u4e00-\u9fa5\u00C0-\u024F\u0900-\u0963\u0966-\u097f]*/,
          {
            // typeKeywords evaluated FIRST so primitive type tokens render as
            // 'type' rather than being eaten by the generic 'keyword' arm.
            // (Defense in depth: the keyword arrays above also have type
            // tokens filtered out, but this ordering keeps the contract clear.)
            cases: {
              '@typeKeywords': 'type',
              '@keywords': 'keyword',
              '@chineseKeywords': 'keyword',
              '@germanKeywords': 'keyword',
              '@hindiKeywords': 'keyword',
              '@default': 'identifier',
            },
          },
        ],

        // Whitespace
        { include: '@whitespace' },

        // Delimiters and operators
        [/[{}()\[\]]/, '@brackets'],
        [/[「」【】]/, '@brackets'], // Chinese brackets
        // 非 ASCII 标点（中文标点 + 天城文 danda「।」「॥」）渲染为 delimiter，
        // 否则会落到 defaultToken='invalid'。这些不在 @symbols 正则里。
        [/[，。：、।॥]/, 'delimiter'],
        [
          /@symbols/,
          {
            cases: {
              '@operators': 'operator',
              '@default': '',
            },
          },
        ],

        // Numbers
        [/\d*\.\d+([eE][\-+]?\d+)?/, 'number.float'],
        [/\d+/, 'number'],

        // Strings
        [/"([^"\\]|\\.)*$/, 'string.invalid'], // non-terminated string
        [/"/, { token: 'string.quote', bracket: '@open', next: '@string' }],
        [/'([^'\\]|\\.)*$/, 'string.invalid'], // non-terminated string
        [/'/, { token: 'string.quote', bracket: '@open', next: '@stringSingle' }],
        // Chinese strings
        [/「/, { token: 'string.quote', bracket: '@open', next: '@stringChinese' }],
      ],

      comment: [
        [/[^#]+/, 'comment'],
        [/#/, 'comment'],
      ],

      string: [
        [/[^\\"]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/"/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],

      stringSingle: [
        [/[^\\']+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/'/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],

      stringChinese: [
        [/[^」\\]+/, 'string'],
        [/@escapes/, 'string.escape'],
        [/\\./, 'string.escape.invalid'],
        [/」/, { token: 'string.quote', bracket: '@close', next: '@pop' }],
      ],

      whitespace: [
        [/[ \t\r\n]+/, 'white'],
        [/#.*$/, 'comment'],
      ],
    },
  });
}

/**
 * Get recommended editor options for Aster CNL
 */
export function getAsterEditorOptions(): import('monaco-editor').editor.IStandaloneEditorConstructionOptions {
  return {
    language: 'aster-cnl',
    minimap: { enabled: false },
    fontSize: 14,
    lineNumbers: 'on',
    automaticLayout: true,
    tabSize: 2,
    insertSpaces: true,
    wordWrap: 'on',
    scrollBeyondLastLine: false,
    renderWhitespace: 'selection',
    bracketPairColorization: { enabled: true },
    guides: {
      indentation: true,
      bracketPairs: true,
    },
    suggest: {
      showKeywords: true,
      showSnippets: true,
    },
    quickSuggestions: {
      other: true,
      comments: false,
      strings: false,
    },
  };
}
