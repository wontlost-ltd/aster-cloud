/**
 * 策略编辑器（Monaco）的 Aster 配色：纯数据，monaco-policy-editor.tsx 用它 defineTheme，
 * 单测（src/__tests__/editor/aster-editor-theme-contrast.test.ts）逐条核对对比度（#774 设计决策 2：
 * 代码高亮的每个 token 在浅 / 暗两套主题下都 ≥ WCAG AA 4.5:1，行号也算正文文字）。
 *
 * 颜色取自 @aster-cloud/tokens 的色阶（Monaco 的 defineTheme 在定义时解析颜色，不能用 CSS 变量）。
 * Monaco 约定：rules[].foreground 是不带 '#' 的 6 位 hex；colors[*] 带 '#'（8 位含 alpha）。
 */
import type { editor } from 'monaco-editor';
import { violet, sky, emerald, amber, rose, zinc } from '@aster-cloud/tokens';

/** Strip leading '#' for use in Monaco's token-color rules. */
const hex = (c: string) => c.replace(/^#/, '');

export function asterEditorTheme(isDark: boolean): editor.IStandaloneThemeData {
  return {
    base: isDark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      // === Module / Rule declarations — the brand-defining landmarks ===
      { token: 'keyword.module',   foreground: hex(isDark ? violet[400] : violet[700]), fontStyle: 'bold' },
      { token: 'keyword.function', foreground: hex(isDark ? violet[300] : violet[600]), fontStyle: 'bold' },

      // === Type / structural keywords (has, given, as one of, …) ===
      { token: 'keyword.type',     foreground: hex(isDark ? sky[300] : sky[700]), fontStyle: 'bold' },
      { token: 'type',             foreground: hex(isDark ? sky[400] : sky[700]) },
      { token: 'keyword.variable', foreground: hex(isDark ? sky[300] : sky[700]) },

      // === Control flow (if, otherwise, for each) ===
      { token: 'keyword.control',  foreground: hex(isDark ? amber[300] : amber[700]), fontStyle: 'bold' },

      // === Workflow / commit keywords (max attempts, retry) ===
      { token: 'keyword.workflow', foreground: hex(isDark ? emerald[300] : emerald[700]), fontStyle: 'bold' },

      // === Async (wait for, after) — pairs with AI/streaming brand color ===
      { token: 'keyword.async',    foreground: hex(isDark ? sky[200] : sky[700]) },

      // === Effects (input/output, side effect markers) ===
      { token: 'keyword.effect',   foreground: hex(isDark ? emerald[200] : emerald[700]), fontStyle: 'italic' },

      // === Operators (and, or, not, divided by) — quiet neutral ===
      { token: 'keyword.operator', foreground: hex(isDark ? zinc[300] : zinc[700]) },

      // === Booleans + null/none — high-contrast rose so they pop ===
      { token: 'keyword.boolean',     foreground: hex(isDark ? rose[300] : rose[700]) },
      { token: 'constant.language',   foreground: hex(isDark ? rose[300] : rose[700]) },

      // === Strings (warm amber range — "human text") ===
      { token: 'string',          foreground: hex(isDark ? amber[200] : amber[800]) },
      { token: 'string.escape',   foreground: hex(isDark ? amber[400] : amber[700]) },
      { token: 'string.invalid',  foreground: hex(isDark ? rose[400] : rose[700]) },

      // === Numbers (emerald — quantitative truth) ===
      { token: 'number',          foreground: hex(isDark ? emerald[200] : emerald[700]) },
      { token: 'number.float',    foreground: hex(isDark ? emerald[200] : emerald[700]) },

      // === Comments (muted italic) ===
      { token: 'comment',         foreground: hex(isDark ? zinc[400] : zinc[500]), fontStyle: 'italic' },

      // === Identifiers (default neutral text) ===
      { token: 'identifier',      foreground: hex(isDark ? zinc[50] : zinc[900]) },

      // === Domain vocabulary terms — sky italic flags them as "your vocabulary" ===
      { token: 'variable.domain', foreground: hex(isDark ? sky[300] : sky[700]), fontStyle: 'italic' },

      // === 名字转义 `x`（ADR 0064 §6，ADR 0058 修订 3 E5/E7）：反引号淡化（与注释同色阶，仍过 AA），
      //     名字用标识符色加下划线，与普通标识符、领域词汇、关键词都区分开 ===
      { token: 'delimiter.escape',   foreground: hex(isDark ? zinc[400] : zinc[500]) },
      { token: 'identifier.escaped', foreground: hex(isDark ? zinc[50] : zinc[900]), fontStyle: 'underline' },

      // === Operators / delimiters (quiet so structure breathes) ===
      { token: 'operator',         foreground: hex(isDark ? zinc[300] : zinc[700]) },
      { token: 'delimiter',        foreground: hex(isDark ? zinc[400] : zinc[600]) },
      // Brackets carry subtle violet so scope is glanceable
      { token: 'delimiter.bracket', foreground: hex(isDark ? violet[300] : violet[600]) },
    ],
    colors: {
      // P1-R19: editor chrome now reads from imported token scales (violet, zinc)
      // instead of raw hex literals. Token updates propagate automatically.
      // Hex8 (RGBA) alpha suffixes kept inline — Monaco accepts standard CSS
      // hex8 syntax and design tokens are emitted as base hex6, so we append
      // the alpha here (no token escape).
      'editor.background':                     isDark ? zinc[950] : '#ffffff',
      'editor.foreground':                     isDark ? zinc[50]  : zinc[900],
      'editorLineNumber.foreground':           isDark ? zinc[400] : zinc[500],
      'editorLineNumber.activeForeground':     isDark ? violet[400] : violet[600],
      'editorCursor.foreground':               isDark ? violet[400] : violet[600],
      // Selection — primary subtle so the text remains legible underneath.
      'editor.selectionBackground':            (isDark ? violet[600] : violet[600]) + (isDark ? '40' : '30'),
      'editor.inactiveSelectionBackground':    (isDark ? violet[600] : violet[600]) + (isDark ? '20' : '18'),
      'editor.lineHighlightBackground':        isDark ? zinc[800] + '80' : zinc[50],
      // Bracket-pair highlight follows the brand
      'editorBracketMatch.background':         (isDark ? violet[600] : violet[600]) + (isDark ? '30' : '15'),
      'editorBracketMatch.border':             isDark ? violet[400] : violet[600],
      // Indent guides — quiet
      'editorIndentGuide.background':          isDark ? zinc[800] : zinc[200],
      'editorIndentGuide.activeBackground':    isDark ? zinc[700] : zinc[300],
      // Find / replace UI
      'editor.findMatchBackground':            (isDark ? violet[600] : violet[600]) + (isDark ? '50' : '30'),
      'editor.findMatchHighlightBackground':   (isDark ? violet[600] : violet[600]) + (isDark ? '30' : '18'),
    },
  };
}
