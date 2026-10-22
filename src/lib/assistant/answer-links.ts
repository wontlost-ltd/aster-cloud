/**
 * 站内助手答复中的 Markdown 链接解析（纯函数，无 React）。
 *
 * <p>模型按 prompt 要求以 `[标题](href)` 引用站内条目；面板曾把它当纯文本原样显示
 * （「[/zh/settings/api-keys](/zh/settings/api-keys)」）。这里只识别**链接**这一种语法——
 * 答复是几句话的短文本，不值得为此引入完整的 Markdown 渲染器。
 *
 * <p><b>href 白名单</b>：答复是模型产出，必须按不可信输入对待。
 * <ul>
 *   <li>站内：以单个 `/` 开头的路径（排除 `//host` 协议相对地址与 `/\` 反斜杠变体）；</li>
 *   <li>站外：只接受 http/https 的绝对地址；</li>
 *   <li>其余（javascript:、data:、相对路径等）一律不生成链接，只保留可读的标题文字。</li>
 * </ul>
 */

export type AnswerSegment =
  | { kind: 'text'; text: string }
  | { kind: 'link'; text: string; href: string; internal: boolean };

/** `[label](href)`：label 不跨行、不含 `]`；href 不含空白与 `)`。 */
const LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/** 判定 href 是否可作链接；返回 null 表示不安全或不认识。 */
export function classifyAnswerHref(href: string): { href: string; internal: boolean } | null {
  if (/^\/(?![/\\])/.test(href)) return { href, internal: true };
  try {
    const url = new URL(href);
    if (url.protocol === 'https:' || url.protocol === 'http:') return { href: url.toString(), internal: false };
  } catch {
    // 非绝对地址：不是站内路径也不是 http(s)，按不安全处理
  }
  return null;
}

/** 把答复切成文本段与链接段；不安全的链接退化为只含标题的文本段。 */
export function parseAnswerLinks(answer: string): AnswerSegment[] {
  const out: AnswerSegment[] = [];
  let last = 0;
  const pushText = (text: string) => {
    if (!text) return;
    const prev = out.at(-1);
    // 相邻文本段合并，渲染层少一层节点
    if (prev?.kind === 'text') prev.text += text;
    else out.push({ kind: 'text', text });
  };
  for (const m of answer.matchAll(LINK)) {
    pushText(answer.slice(last, m.index));
    const target = classifyAnswerHref(m[2]);
    if (target) out.push({ kind: 'link', text: m[1], ...target });
    else pushText(m[1]);
    last = m.index + m[0].length;
  }
  pushText(answer.slice(last));
  return out;
}
