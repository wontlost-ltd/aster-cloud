'use client';

import type { AssistantHit } from '@/lib/assistant/retrieval';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

/**
 * 站内助手的全站共享状态。
 *
 * <p><b>为什么挂在 `[locale]/layout.tsx`</b>：面板要**全站驻留**——在 dashboard、
 * docs、settings 之间跳转时保持打开状态与已有问答，不能每换一页就重置。
 * Next.js App Router 下同一 layout 内的客户端组件在路由切换时**不会重新挂载**，
 * 故把 Provider 放在最外层 locale layout 即可实现"跨页面不丢"。
 *
 * <p><b>开关持久化</b>：用 localStorage（`aster.assistant.enabled`）。
 * 关闭后必须去「设置 → 助手」重新激活——这是刻意的：助手是常驻 UI，
 * 误触关掉后若能随手打开就失去了"关闭"的意义。
 *
 * <p><b>刷新语义</b>：会话内容（问答记录）**不跨浏览器刷新持久化**——它是易失的
 * 检索上下文，不是用户数据；跨页面导航保留即可。开关本身则跨刷新保留。
 */

/** 一轮问答：用户问句 + 站内检索到的结果快照。 */
export interface AssistantTurn {
  id: string;
  query: string;
  /**
   * 结果在提问那一刻就固化，之后切页面/切语言都不重算（保证记录可回溯）。
   *
   * <p>直接复用 {@link AssistantHit}——此前这里手写了一份结构，
   * 加 kind='external' 时两处就漂移了。单一真相源避免下次再漏。
   */
  hits: AssistantHit[];
  /**
   * 联网应答器产出的自然语言答复（预留给「数字人」，见 lib/assistant/provider.ts）。
   *
   * <p>undefined = 纯离线检索模式（当前默认）。有值时**附加**在检索结果之上显示，
   * 而不是取代——检索命中永远可见，保证答案可溯源。
   */
  answer?: string;
  /** 应答流是否仍在进行（用于显示光标/加载态）。 */
  answering?: boolean;
  /** 应答失败时的原因标识；面板据此提示"已降级为站内检索"。 */
  answerError?: 'failed' | 'aborted';
}

interface AssistantState {
  /** 用户是否启用了助手（设置项，跨刷新保留）。 */
  enabled: boolean;
  /** localStorage 读完前为 true——避免 SSR/首帧闪烁出错误状态。 */
  hydrating: boolean;
  setEnabled: (v: boolean) => void;
  /** 面板是否展开（跨页面导航保留，不跨刷新）。 */
  open: boolean;
  setOpen: (v: boolean) => void;
  /** 问答记录（跨页面导航保留）。 */
  turns: AssistantTurn[];
  addTurn: (turn: AssistantTurn) => void;
  /**
   * 就地更新某一回合（流式应答逐字追加时用）。
   *
   * <p>用 patch 而非整体替换：应答流每来一个 delta 就要刷新一次，
   * 整体替换会把同一回合的 hits 反复重建，列表 key 抖动。
   */
  patchTurn: (id: string, patch: Partial<AssistantTurn>) => void;
  clearTurns: () => void;
  /**
   * 悬浮按钮是否被页面临时让出（如策略编辑器「AI」tab 打开时，那里本身就是 AI 入口）。
   * 只影响悬浮按钮，不改变开关、不关闭已展开的面板。
   */
  launcherSuppressed: boolean;
  /** 申请让出悬浮按钮，返回释放函数；多个申请方按计数叠加，全部释放后恢复。 */
  suppressLauncher: () => () => void;
  /** 页面末尾的按钮安全区是否被页面临时取消（视口内自适应高度的页面自己给按钮让位）。 */
  safeAreaSuppressed: boolean;
  /** 申请取消底部安全区，返回释放函数；计数语义同 suppressLauncher。 */
  suppressSafeArea: () => () => void;
}

const AssistantContext = createContext<AssistantState | null>(null);

/** 计数式申请：加一并返回只生效一次的释放函数（effect 清理与手动释放可能重复调用）。 */
function acquire(setCount: (update: (n: number) => number) => void): () => void {
  setCount((n) => n + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    setCount((n) => n - 1);
  };
}

export const ASSISTANT_ENABLED_KEY = 'aster.assistant.enabled';

/** 默认开启：新用户应能直接看到入口，否则等于没上线。 */
const DEFAULT_ENABLED = true;

/* ---------------- localStorage 外部存储适配 ---------------- */

/** 订阅者集合：同一标签页内多个组件共享一次读取。 */
const listeners = new Set<() => void>();

/**
 * ★缓存快照：`useSyncExternalStore` 要求 getSnapshot 在数据未变时返回
 * **同一个值**（===）。若每次都现读 localStorage 并返回新值，React 会认为
 * 状态一直在变而无限重渲染。故这里维护一个缓存，只在写入/跨标签页事件时失效。
 */
let cachedEnabled: boolean | null = null;

function getEnabledSnapshot(): boolean {
  if (cachedEnabled === null) {
    try {
      const raw = window.localStorage.getItem(ASSISTANT_ENABLED_KEY);
      cachedEnabled = raw === null ? DEFAULT_ENABLED : raw === 'true';
    } catch {
      // 隐私模式/存储被禁 → 用默认值，功能不受影响（只是开关不持久）。
      cachedEnabled = DEFAULT_ENABLED;
    }
  }
  return cachedEnabled;
}

function subscribeEnabled(onChange: () => void): () => void {
  listeners.add(onChange);
  // 跨标签页同步：另一个标签页改了开关，这里也要跟着变。
  const onStorage = (e: StorageEvent) => {
    if (e.key === ASSISTANT_ENABLED_KEY) {
      cachedEnabled = null;
      onChange();
    }
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener('storage', onStorage);
  };
}

function writeEnabled(v: boolean): void {
  cachedEnabled = v;
  try {
    window.localStorage.setItem(ASSISTANT_ENABLED_KEY, String(v));
  } catch {
    /* 存不下也不该让 UI 失效——本次会话内仍按 v 生效 */
  }
  // storage 事件不会在**当前**标签页触发，故手动通知本页订阅者。
  for (const l of listeners) l();
}

/** 是否已完成客户端挂载（用于遮住首帧默认值）。 */
function useHasMounted(): boolean {
  return useSyncExternalStore(
    () => () => {},
    () => true,
    () => false,
  );
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  // ★localStorage 是**外部可变数据源**，用 useSyncExternalStore 读而不是
  //   "useEffect 里 setState"：后者会触发级联渲染（eslint
  //   react-hooks/set-state-in-effect），且 SSR 快照与首帧不一致。
  //   getServerSnapshot 固定返回默认值，故服务端渲染与首帧 HTML 一致，
  //   不会 hydration mismatch；挂载后 React 自动切到 getSnapshot 的真值。
  const enabled = useSyncExternalStore(
    subscribeEnabled,
    getEnabledSnapshot,
    () => DEFAULT_ENABLED,
  );
  // 仅用于遮住"客户端首帧尚未取到真值"的那一瞬（见 AssistantPanel）。
  const hydrating = !useHasMounted();
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  // 计数而非布尔：两个页面区域同时申请时，一方释放不应让按钮提前回来。
  const [suppressCount, setSuppressCount] = useState(0);

  const setEnabled = useCallback((v: boolean) => {
    writeEnabled(v);
    // 关闭时一并收起面板，避免"已关闭却还浮着"的矛盾状态。
    if (!v) setOpen(false);
  }, []);

  const addTurn = useCallback((turn: AssistantTurn) => {
    setTurns((prev) => [...prev, turn]);
  }, []);

  const patchTurn = useCallback((id: string, patch: Partial<AssistantTurn>) => {
    setTurns((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const clearTurns = useCallback(() => setTurns([]), []);

  const suppressLauncher = useCallback(() => acquire(setSuppressCount), []);
  const launcherSuppressed = suppressCount > 0;
  const [safeAreaSuppressCount, setSafeAreaSuppressCount] = useState(0);
  const suppressSafeArea = useCallback(() => acquire(setSafeAreaSuppressCount), []);
  const safeAreaSuppressed = safeAreaSuppressCount > 0;

  const value = useMemo<AssistantState>(
    () => ({
      enabled,
      hydrating,
      setEnabled,
      open,
      setOpen,
      turns,
      addTurn,
      patchTurn,
      clearTurns,
      launcherSuppressed,
      suppressLauncher,
      safeAreaSuppressed,
      suppressSafeArea,
    }),
    [
      enabled, hydrating, setEnabled, open, turns, addTurn, patchTurn, clearTurns,
      launcherSuppressed, suppressLauncher, safeAreaSuppressed, suppressSafeArea,
    ],
  );

  return <AssistantContext.Provider value={value}>{children}</AssistantContext.Provider>;
}

/**
 * 读助手状态。
 *
 * <p>Provider 之外调用返回 null 而非抛错——助手是**可选增强**，
 * 不该因为某个页面忘了包 Provider 就把整页打挂。
 */
export function useAssistant(): AssistantState | null {
  return useContext(AssistantContext);
}

/**
 * 右下角悬浮助手按钮此刻是否显示。
 *
 * <p>AssistantPanel 按此决定是否渲染按钮；贴底的页面元素（如策略编辑器状态栏）
 * 也按此给按钮让位。两处共用这一个判断，避免各写一份条件后漂移。
 */
export function isAssistantLauncherVisible(state: AssistantState | null): boolean {
  return state !== null && !state.hydrating && state.enabled && !state.open && !state.launcherSuppressed;
}

/**
 * active 为 true 期间让出右下角悬浮按钮（卸载或 active 变 false 时自动恢复）。
 *
 * <p>用于本身就是 AI 入口、且内容贴到视口右下角的区域（策略编辑器「AI」tab）：
 * 两个 AI 入口叠在一起容易点错——想点「发送」却打开了站内助手。
 */
export function useSuppressAssistantLauncher(active: boolean): void {
  const suppress = useAssistant()?.suppressLauncher;
  useEffect(() => {
    if (!active || !suppress) return;
    return suppress();
  }, [active, suppress]);
}

/**
 * active 为 true 期间取消页面末尾的按钮安全区（卸载或 active 变 false 时恢复）。
 *
 * <p>用于按视口自适应高度的页面（策略编辑器）：内容本身已填满首屏、贴底元素自行给按钮让位，
 * 再在末尾加 5rem 安全区只会让整页多出一段滚动。
 */
export function useSuppressLauncherSafeArea(active: boolean): void {
  const suppress = useAssistant()?.suppressSafeArea;
  useEffect(() => {
    if (!active || !suppress) return;
    return suppress();
  }, [active, suppress]);
}

/**
 * 页面底部安全区：悬浮按钮显示时在内容末尾留出按钮占位高度，
 * 保证滚到底时最后一行内容（如仪表盘「查看全部」）不会压在按钮下面。
 *
 * <p>高度 = 按钮 48px + 底边距 16px + 16px 间隙 = 5rem，与按钮的 fixed 定位同源。
 */
export function AssistantLauncherSafeArea() {
  const state = useAssistant();
  if (!isAssistantLauncherVisible(state) || state?.safeAreaSuppressed) return null;
  return <div aria-hidden data-testid="assistant-launcher-safe-area" className="h-20" />;
}
