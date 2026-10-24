export interface ExecutableVersionCandidate {
  id: string;
  version: number;
  content?: string;
  aliasSet?: string | null;
  status: 'APPROVED' | 'DRAFT' | 'PENDING_APPROVAL' | 'REJECTED' | 'DEPRECATED' | 'ARCHIVED';
  isDefault: boolean;
  sourceToolchainId?: string | null;
  vocabularySnapshotIds?: unknown;
}

export interface ExecutablePolicyVersion extends ExecutableVersionCandidate {
  source: 'default' | 'approved' | 'latest';
}

/** 选择执行版本：默认版本优先，其次最高已批准版本，最后兼容无审批历史的策略。 */
export function resolveExecutableVersion<T extends ExecutableVersionCandidate>(
  versions: readonly T[],
  fallback: T,
): T & { source: ExecutablePolicyVersion['source'] } {
  const defaultVersion = versions.find((version) => version.isDefault);
  if (defaultVersion) return { ...defaultVersion, source: 'default' };

  const approvedVersion = versions
    .filter((version) => version.status === 'APPROVED')
    .reduce<T | null>((latest, version) =>
      !latest || version.version > latest.version ? version : latest, null);
  if (approvedVersion) return { ...approvedVersion, source: 'approved' };

  const latestVersion = versions.reduce<T | null>((latest, version) =>
    !latest || version.version > latest.version ? version : latest, null);
  if (!latestVersion || fallback.version > latestVersion.version) {
    return { ...fallback, source: 'latest' };
  }
  return { ...latestVersion, source: 'latest' };
}

/** 防止并发缓存写回将当前可执行版本覆盖成旧版本。 */
export function isCachedVersionCurrent(
  cachedVersion: number | null | undefined,
  executableVersion: number | null | undefined,
): boolean {
  return cachedVersion === executableVersion;
}

/** 仅在选中的版本不是策略行当前版本时读取其完整执行内容。 */
export async function hydrateExecutableVersion<
  T extends ExecutableVersionCandidate,
  U extends ExecutableVersionCandidate,
>(
  selected: T & { source: ExecutablePolicyVersion['source'] },
  current: U,
  loadVersion: (version: number) => Promise<U | null>,
): Promise<(U & { source: ExecutablePolicyVersion['source'] }) | null> {
  if (selected.version === current.version) {
    return { ...current, source: selected.source };
  }
  const version = await loadVersion(selected.version);
  return version ? { ...version, source: selected.source } : null;
}
