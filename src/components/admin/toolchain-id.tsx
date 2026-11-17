import { Fragment } from 'react';

/**
 * 工具链标识（如 `abi=2.0;core=1.0.47;validator=1;resolver=1;casefold=15.1;build=<40 位提交哈希>`）。
 *
 * 整串没有空格，窄屏下会撑出视口。这里在每个 `;` 之后放 `<wbr>`，优先在分隔符处换行；
 * 单段仍放不下（如 build 哈希）时由 overflow-wrap:anywhere 兜底断开。`<wbr>` 不产生字符，
 * 选中复制得到的仍是原始完整值。
 */
export function ToolchainId({ value, className }: { value: string; className?: string }) {
  const parts = value.split(';');
  return (
    <code className={`font-mono [overflow-wrap:anywhere]${className ? ` ${className}` : ''}`}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 && (
            <>
              ;<wbr />
            </>
          )}
        </Fragment>
      ))}
    </code>
  );
}
