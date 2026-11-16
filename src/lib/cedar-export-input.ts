/**
 * 已存版本交给 aster-api 做 Cedar 导出 / 可导出性检查时的编译输入（ADR 0047 §6，#786）。
 *
 * 导出路由与详情页的可导出性检查共用这一份：检查的必须正是导出会提交的内容（源码、冻结别名集、
 * 与执行同一判定的语言与领域词汇、结构词授权），否则「显示了按钮却导不出」或反之。
 */
import { loadStoredVersionCompileContext, type StoredVersionCompileInput } from '@/lib/execution-input';
import type { PolicyCedarExportRequest } from '@/services/policy/policy-api';

/** 版本行中导出所需的列（与 findDefaultExecutableVersion / policyVersions 行同形） */
export type CedarExportVersion = Omit<StoredVersionCompileInput, 'source' | 'teamId'> & {
  source: string | null;
  content: string;
  aliasSet: string | null;
};

export interface CedarExportInput {
  /** 不含 functionName / claimedRef 的请求体，二者由导出路由按需追加 */
  request: Omit<PolicyCedarExportRequest, 'functionName' | 'claimedRef'>;
  /** 实际编译的源码（版本 source，旧版本回退 content） */
  source: string;
  /** 版本的领域词汇；无词汇时为 undefined */
  vocabulary: Record<string, unknown> | undefined;
}

// 版本冻结的别名集（canonical JSON）；与执行路径同一口径，解析失败视同无别名
function parseAliasSet(aliasSet: string | null): Record<string, string[]> | null {
  if (!aliasSet) return null;
  try {
    return JSON.parse(aliasSet) as Record<string, string[]>;
  } catch {
    return null;
  }
}

/**
 * 组装编译输入。词汇严格加载：失败时抛出（VersionVocabularyUnavailableError / 引擎词汇错误），
 * 调用方不得退化为无词汇导出——产物会与执行语义不符。
 */
export async function loadCedarExportInput(version: CedarExportVersion, teamId: string | null): Promise<CedarExportInput> {
  const source = version.source ?? version.content;
  const { locale, vocabulary } = await loadStoredVersionCompileContext({ ...version, source, teamId });
  const aliasSet = parseAliasSet(version.aliasSet);
  return {
    source,
    vocabulary,
    request: {
      source,
      locale,
      aliasSet,
      // 冻结即信任：与执行路径同一判定，已批准版本的别名集按已授权编译（含结构词别名）。
      // aster-api 仅对 HMAC 已验签的调用方采信该标记；无别名时不带，保持原请求形状。
      ...(aliasSet && Object.keys(aliasSet).length > 0 ? { allowStructural: true } : {}),
      ...(vocabulary ? { vocabulary } : {}),
    },
  };
}
