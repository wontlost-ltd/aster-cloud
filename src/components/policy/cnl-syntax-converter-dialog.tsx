'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { type SupportedLocale } from '@/data/policy-examples';
import { convertCNLSyntax, getSupportedLocales, getLocaleName } from '@/lib/cnl-syntax-converter';
import { detectCNLLanguage } from '@/lib/cnl-language-detector';

interface CNLSyntaxConverterDialogProps {
  isOpen: boolean;
  onClose: () => void;
  content: string;
  currentLocale: SupportedLocale;
  uiLocale: string;
  onApply: (convertedContent: string, newLocale: SupportedLocale) => void;
}

/**
 * CNL 语法转换对话框
 *
 * 允许用户将策略从一种 CNL 语言转换为另一种
 */
export function CNLSyntaxConverterDialog({
  isOpen,
  onClose,
  content,
  currentLocale,
  uiLocale,
  onApply,
}: CNLSyntaxConverterDialogProps) {
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const [targetLocale, setTargetLocale] = useState<SupportedLocale>(() => {
    // 默认选择不同于当前语言的第一个语言
    const locales = getSupportedLocales();
    return locales.find((l) => l !== currentLocale) || 'en-US';
  });

  const isZh = uiLocale.startsWith('zh');

  // 自动检测当前内容的语言
  const detectedLocale = useMemo(() => {
    const result = detectCNLLanguage(content);
    return result.confidence >= 50 ? result.detected : currentLocale;
  }, [content, currentLocale]);

  // 转换预览
  const conversionResult = useMemo(() => {
    return convertCNLSyntax(content, detectedLocale, targetLocale);
  }, [content, detectedLocale, targetLocale]);

  // 处理应用转换
  const handleApply = useCallback(() => {
    if (conversionResult.success) {
      onApply(conversionResult.content, targetLocale);
      onClose();
    }
  }, [conversionResult, targetLocale, onApply, onClose]);

  // 获取语言选项
  const languageOptions = useMemo(() => {
    return getSupportedLocales().map((locale) => ({
      value: locale,
      label: getLocaleName(locale, uiLocale),
      flag: locale === 'en-US' ? '🇺🇸' : locale === 'zh-CN' ? '🇨🇳' : '🇩🇪',
    }));
  }, [uiLocale]);

  // Focus on cancel button when dialog opens
  useEffect(() => {
    if (isOpen && cancelButtonRef.current) {
      cancelButtonRef.current.focus();
    }
  }, [isOpen]);

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/25 backdrop-blur-sm transition-opacity"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Dialog Container */}
      <div className="flex min-h-full items-center justify-center p-4">
        <div
          className="relative w-full max-w-4xl transform overflow-hidden rounded-2xl bg-bg shadow-xl transition-all"
          role="dialog"
          aria-modal="true"
          aria-labelledby="converter-dialog-title"
        >
          {/* 标题栏 */}
          <div className="border-b border-border px-6 py-4">
            <h3 id="converter-dialog-title" className="text-lg font-semibold text-fg">
              {isZh ? '语法转换' : 'Syntax Conversion'}
            </h3>
            <p className="mt-1 text-sm text-fg-muted">
              {isZh
                ? '将策略从一种 CNL 语言转换为另一种语言'
                : 'Convert your policy from one CNL language to another'}
            </p>
          </div>

          {/* 内容区域 */}
          <div className="px-6 py-4">
            {/* 语言选择 */}
            <div className="flex items-center gap-4 mb-4">
              {/* 源语言（自动检测） */}
              <div className="flex-1">
                <label className="block text-sm font-medium text-fg mb-1">
                  {isZh ? '源语言' : 'Source Language'}
                </label>
                <div className="flex items-center gap-2 px-3 py-2 bg-bg-subtle rounded-lg border border-border">
                  <span className="text-lg">
                    {detectedLocale === 'en-US' ? '🇺🇸' : detectedLocale === 'zh-CN' ? '🇨🇳' : '🇩🇪'}
                  </span>
                  <span className="text-sm text-fg">
                    {getLocaleName(detectedLocale, uiLocale)}
                  </span>
                  <span className="text-xs text-fg-subtle ml-auto">
                    {isZh ? '（自动检测）' : '(auto-detected)'}
                  </span>
                </div>
              </div>

              {/* 箭头 */}
              <div className="flex items-center justify-center pt-6">
                <svg className="w-6 h-6 text-fg-subtle" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                </svg>
              </div>

              {/* 目标语言 */}
              <div className="flex-1">
                <label className="block text-sm font-medium text-fg mb-1">
                  {isZh ? '目标语言' : 'Target Language'}
                </label>
                <select
                  value={targetLocale}
                  onChange={(e) => setTargetLocale(e.target.value as SupportedLocale)}
                  className="w-full px-3 py-2 bg-bg rounded-lg border border-border-strong text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
                >
                  {languageOptions.map((option) => (
                    <option
                      key={option.value}
                      value={option.value}
                      disabled={option.value === detectedLocale}
                    >
                      {option.flag} {option.label}
                      {option.value === detectedLocale ? (isZh ? ' (当前)' : ' (current)') : ''}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* 预览区域 */}
            <div className="grid grid-cols-2 gap-4">
              {/* 原始内容 */}
              <div>
                <label className="block text-sm font-medium text-fg mb-2">
                  {isZh ? '原始内容' : 'Original'}
                </label>
                <div className="h-64 overflow-auto rounded-lg border border-border bg-gray-900 p-3">
                  <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
                    {content || (isZh ? '（空内容）' : '(empty)')}
                  </pre>
                </div>
              </div>

              {/* 转换后内容 */}
              <div>
                <label className="block text-sm font-medium text-fg mb-2">
                  {isZh ? '转换预览' : 'Preview'}
                </label>
                <div className="h-64 overflow-auto rounded-lg border border-border bg-gray-900 p-3">
                  {conversionResult.success ? (
                    <pre className="text-sm text-gray-300 font-mono whitespace-pre-wrap">
                      {conversionResult.content || (isZh ? '（空内容）' : '(empty)')}
                    </pre>
                  ) : (
                    <div className="flex items-center justify-center h-full text-red-400 text-sm">
                      {isZh ? '转换失败' : 'Conversion failed'}
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* 警告信息 */}
            {conversionResult.warnings.length > 0 && (
              <div className="mt-4 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <div className="flex items-start gap-2">
                  <svg className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-amber-800">
                      {isZh ? '转换警告' : 'Conversion Warnings'}
                    </p>
                    <ul className="mt-1 text-sm text-amber-700 list-disc list-inside">
                      {conversionResult.warnings.map((warning, i) => (
                        <li key={i}>{warning}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {/* 提示信息 */}
            <div className="mt-4 p-3 bg-blue-50 border border-blue-200 rounded-lg">
              <div className="flex items-start gap-2">
                <svg className="w-5 h-5 text-blue-500 mt-0.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <div className="text-sm text-blue-700">
                  {isZh ? (
                    <>
                      <p className="font-medium">转换说明</p>
                      <ul className="mt-1 list-disc list-inside text-blue-600">
                        <li>转换会替换关键字和标点符号</li>
                        <li>字符串字面量内容保持不变</li>
                        <li>建议转换后检查代码正确性</li>
                      </ul>
                    </>
                  ) : (
                    <>
                      <p className="font-medium">Conversion Notes</p>
                      <ul className="mt-1 list-disc list-inside text-blue-600">
                        <li>Keywords and punctuation will be replaced</li>
                        <li>String literal contents remain unchanged</li>
                        <li>Review the converted code for correctness</li>
                      </ul>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* 操作按钮 */}
          <div className="border-t border-border px-6 py-4 flex justify-end gap-3">
            <button
              type="button"
              ref={cancelButtonRef}
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-fg bg-bg border border-border-strong rounded-lg hover:bg-bg-subtle focus:outline-none focus:ring-2 focus:ring-gray-500 focus:ring-offset-2 transition-colors"
            >
              {isZh ? '取消' : 'Cancel'}
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!conversionResult.success || detectedLocale === targetLocale}
              className="px-4 py-2 text-sm font-medium text-primary-fg bg-primary rounded-lg hover:bg-primary-hover focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isZh ? '应用转换' : 'Apply Conversion'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * 转换按钮组件（用于触发对话框）
 */
interface CNLConvertButtonProps {
  onClick: () => void;
  uiLocale: string;
  disabled?: boolean;
  className?: string;
}

export function CNLConvertButton({
  onClick,
  uiLocale,
  disabled = false,
  className = '',
}: CNLConvertButtonProps) {
  const isZh = uiLocale.startsWith('zh');

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-primary-hover bg-primary-subtle border border-primary/30 rounded-lg hover:bg-primary-subtle focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-1 transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
      title={isZh ? '将策略转换为其他语言' : 'Convert policy to another language'}
    >
      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
      </svg>
      {isZh ? '语法转换' : 'Convert'}
    </button>
  );
}
