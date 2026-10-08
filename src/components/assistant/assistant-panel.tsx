'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { useAssistant } from './assistant-context';
import { retrieve } from '@/lib/assistant/retrieval';
import {
  getDocsSearchIndex,
  getDocsRoutePrefix,
  getExternalDocs,
  buildDocsSeeds,
} from '@/lib/docs/dashboard-docs-seeds';
import { buildCommands, type Command } from '@/components/dashboard/command-palette-commands';
import { getAssistantAnswerProvider } from '@/lib/assistant/provider';

/**
 * 站内助手面板（全站驻留）。
 *
 * <p><b>默认不联网</b>：不调 LLM、不发请求出站、不读用户数据。它把问句映射到站内
 * **已有事实源**（文档索引 + 导航/动作），每条答案都是可点击的站内链接，不存在幻觉编造。
 *
 * <p><b>联网预留</b>：若通过 {@code registerAssistantAnswerProvider} 注册了应答器
 * （日后接「数字人」），面板会把本地检索命中作为 grounding 传给它，并逐字流式展示答复。
 * 检索结果**始终照常显示**，应答失败/中止只标记降级——联网是增强，不是替代。
 *
 * <p>状态全部来自 {@link useAssistant}（挂在 locale layout），故切换页面时
 * 面板开合与问答记录都不丢；只有浏览器刷新才清空会话（开关本身跨刷新保留）。
 */
export function AssistantPanel() {
  const t = useTranslations('assistant');
  // 复用命令面板既有的两个命名空间——标签已在 4 语言包里齐全，
  // 助手不再另造一套导航文案（否则同一个「策略」会出现两处译文，必然漂移）。
  const tNav = useTranslations('dashboardNav');
  const tCmd = useTranslations('dashboardNav.commandPalette');
  const locale = useLocale();
  const state = useAssistant();
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  /** 在途应答的中止句柄（仅联网模式下使用）。 */
  const answerAbortRef = useRef<AbortController | null>(null);

  const commands: Command[] = useMemo(
    () =>
      buildCommands({
        // 与 dashboard layout 同口径：en 无前缀，其余带 /<locale>。
        routePrefix: locale === 'en' ? '' : `/${locale}`,
        labels: {
          dashboard: tNav('dashboard'),
          policies: tNav('policies'),
          reports: tNav('reports'),
          approvals: tNav('approvals'),
          teams: tNav('teams'),
          security: tNav('security'),
          billing: tNav('billing'),
          settings: tNav('settings'),
          newPolicy: tCmd('newPolicy'),
          apiKeys: tCmd('apiKeys'),
          aiKeys: tCmd('aiKeys'),
          aiAssistant: tCmd('aiAssistant'),
        },
        // ★助手**不做 RBAC 判定**：它只检索指路，权限由目标页面自己校验。
        //   这里保守地不展示 billing（管理员专属入口），避免给普通成员
        //   指一条必然被拦的路；create 类保留，成员本就可建策略。
        showBilling: false,
        docsSeeds: buildDocsSeeds(locale),
      }),
    [locale, tNav, tCmd],
  );

  const docsIndex = useMemo(() => getDocsSearchIndex(locale), [locale]);
  // aster-lang.dev 的文档（构建期抓取内联，非运行时请求）。
  const external = useMemo(() => getExternalDocs(locale), [locale]);

  const open = state?.open ?? false;

  // 打开时聚焦输入框；新回合追加后滚到底部。
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (open) listEndRef.current?.scrollIntoView({ block: 'end' });
  }, [open, state?.turns.length]);

  // Esc 收起（不是"关闭助手"——关闭只能在设置里，见 assistant-context 注释）。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') state?.setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, state]);

  // 动作的 subtitle 用**已翻译的分组名**——Command.group 是内部 id（'docs'/'navigate'…），
  // 直接显示会在界面上漏出英文原始值。
  const groupLabels = useMemo<Record<Command['group'], string>>(
    () => ({
      navigate: tCmd('groupNavigate'),
      create: tCmd('groupCreate'),
      settings: tCmd('groupSettings'),
      docs: tCmd('groupDocs'),
    }),
    [tCmd],
  );

  const submit = useCallback(() => {
    const q = query.trim();
    if (!q || !state) return;
    const hits = retrieve(q, {
      docsIndex,
      commands,
      // ★用 getDocsRoutePrefix 而非当前 locale：hi 无文档索引会回退 en，
      //   前缀必须跟着回退，否则 /hi/docs/... 全 404。
      docsPrefix: getDocsRoutePrefix(locale),
      external,
      limit: 8,
    }).map((h) =>
      h.kind === 'action'
        ? { ...h, subtitle: groupLabels[h.subtitle as Command['group']] ?? h.subtitle }
        : h,
    );
    // 用 length + query 组合成稳定 key：不用 Date.now()（同一毫秒内连发会撞），
    // 也不用随机数（React 严格模式下双渲染会变）。
    const turnId = `${state.turns.length}:${q}`;
    const provider = getAssistantAnswerProvider();
    state.addTurn({ id: turnId, query: q, hits, answering: provider !== null });
    setQuery('');

    // 未注册应答器 → 纯离线检索模式（当前默认），到此为止。
    if (!provider) return;

    // 新提问中止上一条在途应答，避免两股流交错写同一面板。
    answerAbortRef.current?.abort();
    const controller = new AbortController();
    answerAbortRef.current = controller;

    void (async () => {
      let acc = '';
      try {
        for await (const chunk of provider.answer({
          query: q,
          groundingHits: hits,
          locale,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return;
          acc += chunk.delta;
          state.patchTurn(turnId, { answer: acc });
        }
        state.patchTurn(turnId, { answering: false });
      } catch {
        // ★联网只做增强，不做替代：应答失败时保留已检索到的站内结果，
        //   只标记降级，不清空 hits、不弹错误框。
        state.patchTurn(turnId, {
          answering: false,
          answerError: controller.signal.aborted ? 'aborted' : 'failed',
        });
      }
    })();
  }, [query, state, docsIndex, commands, external, locale, groupLabels]);

  // 面板收起时中止在途应答，避免看不见的请求继续烧配额。
  useEffect(() => {
    if (!open) answerAbortRef.current?.abort();
  }, [open]);

  // 未启用 / Provider 缺失 / 首帧未 hydrate → 不渲染任何东西
  // （hydrating 期间不渲染，避免"先闪出来又消失"）。
  if (!state || state.hydrating || !state.enabled) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => state.setOpen(true)}
        aria-label={t('open')}
        className="fixed bottom-4 right-4 z-40 inline-flex h-12 w-12 items-center justify-center rounded-full bg-primary text-white shadow-lg transition hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary"
      >
        {/* 内联 SVG：避免为一个图标引入依赖 */}
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
            d="M8 10h.01M12 10h.01M16 10h.01M21 12a8 8 0 01-8 8H7l-4 3V12a8 8 0 018-8h2a8 8 0 018 8z" />
        </svg>
      </button>
    );
  }

  return (
    <aside
      role="complementary"
      aria-label={t('title')}
      className="fixed bottom-4 right-4 z-40 flex h-[min(32rem,calc(100vh-2rem))] w-[min(24rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-xl border border-border bg-bg shadow-2xl"
    >
      <header className="flex items-center justify-between border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-fg">{t('title')}</h2>
        <button
          type="button"
          onClick={() => state.setOpen(false)}
          aria-label={t('close')}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-fg-muted transition-colors hover:bg-bg-subtle hover:text-fg focus:outline-none focus:ring-2 focus:ring-primary"
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </header>

      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        {state.turns.length === 0 ? (
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">{t('intro')}</p>
            {/* 明确告知边界：不联网、不生成、不读数据——避免用户误当成 AI 客服 */}
            <p className="text-xs text-fg-subtle">{t('introNote')}</p>
          </div>
        ) : (
          state.turns.map((turn) => (
            <div key={turn.id} className="space-y-2">
              <p className="rounded-lg bg-primary-subtle px-3 py-2 text-sm text-fg">{turn.query}</p>

              {/* 联网应答（数字人）。未注册应答器时 turn.answer 恒为 undefined，
                  这一段完全不渲染 —— 纯离线模式下 DOM 与之前一致。 */}
              {(turn.answer || turn.answering) && (
                <p className="whitespace-pre-wrap px-1 text-sm text-fg">
                  {turn.answer}
                  {turn.answering && (
                    <span className="ml-0.5 inline-block animate-pulse" aria-hidden>
                      ▍
                    </span>
                  )}
                </p>
              )}
              {turn.answerError === 'failed' && (
                // 降级提示：说明"答复没出来，但下面的站内结果照常可用"。
                <p className="px-1 text-xs text-fg-subtle">{t('answerFallback')}</p>
              )}

              {turn.hits.length === 0 ? (
                <p className="px-1 text-sm text-fg-muted">{t('noResults')}</p>
              ) : (
                <ul className="space-y-1" aria-label={t('resultsLabel')}>
                  {turn.hits.map((hit) => (
                    <li key={hit.id}>
                      {/* ★用 next/link 而非原生 <a>：原生 <a> 触发**整页导航**，
                          React 树被销毁重建 → 面板收起、问答记录全清。用户点一条
                          结果就丢失上下文，等于每次只能问一个问题。
                          next/link 走客户端路由，Provider 挂在 layout 不重新挂载，
                          面板与记录都保留（这正是"全站驻留"的意义）。
                          href 已含 locale 前缀，直接用 next/link 即可，
                          不需要 i18n 的 Link 再包一层前缀。 */}
                      {/* 站外结果用原生 <a> + 新标签页：next/link 只管站内路由，
                          且用户不该因为点了一条参考资料就离开当前工作上下文。
                          rel=noreferrer 避免把站内路径泄露给外站。 */}
                      <Link
                        href={hit.href}
                        {...(hit.kind === 'external'
                          ? { target: '_blank', rel: 'noreferrer' }
                          : {})}
                        className="block rounded-md px-3 py-2 transition-colors hover:bg-bg-subtle focus:outline-none focus:ring-2 focus:ring-primary"
                      >
                        <span className="flex items-center gap-2">
                          <span className="rounded bg-bg-muted px-1.5 py-0.5 text-[10px] text-fg-muted">
                            {hit.kind === 'doc'
                              ? t('kindDoc')
                              : hit.kind === 'external'
                                ? t('kindExternal')
                                : t('kindAction')}
                          </span>
                          <span className="text-sm font-medium text-fg">{hit.title}</span>
                          {/* 明确告知这条来自站外、会新开标签页 */}
                          {hit.sourceLabel && (
                            <span className="text-[10px] text-fg-subtle">↗ {hit.sourceLabel}</span>
                          )}
                        </span>
                        {hit.subtitle && (
                          <span className="mt-0.5 block text-xs text-fg-muted">{hit.subtitle}</span>
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))
        )}
        <div ref={listEndRef} />
      </div>

      <form
        className="border-t border-border p-3"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('placeholder')}
          aria-label={t('placeholder')}
          className="w-full rounded-md border border-border bg-bg-soft px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:outline-none focus:ring-2 focus:ring-primary"
        />
      </form>
    </aside>
  );
}
