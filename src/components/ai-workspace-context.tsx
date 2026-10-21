'use client';

import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';

/**
 * AI 工作台（ADR 0049）在当前用户上的服务端判定结果。
 * dashboard layout 已按 session 与环境变量算过一次，这里经 context 下发给策略编辑器，
 * 避免每个使用 PolicyForm 的页面重复计算。null 表示功能关闭，编辑器沿用原 AI 面板。
 */
export type AiWorkspaceConfig = { base: string; enabled: boolean };

const AiWorkspaceContext = createContext<AiWorkspaceConfig | null>(null);

export function AiWorkspaceProvider({ value, children }: { value: AiWorkspaceConfig | null; children: ReactNode }) {
  return <AiWorkspaceContext.Provider value={value}>{children}</AiWorkspaceContext.Provider>;
}

/** 不在 provider 内（如测试或 dashboard 外的页面）时返回 null，即功能关闭。 */
export function useAiWorkspace(): AiWorkspaceConfig | null {
  return useContext(AiWorkspaceContext);
}
