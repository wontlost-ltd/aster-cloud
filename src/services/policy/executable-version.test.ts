import { describe, expect, it, vi } from 'vitest';
import { hydrateExecutableVersion, isCachedVersionCurrent, resolveExecutableVersion, type ExecutableVersionCandidate } from './executable-version';

const version = (id: string, number: number, status: ExecutableVersionCandidate['status'], isDefault = false): ExecutableVersionCandidate => ({
  id,
  version: number,
  content: `content-${id}`,
  aliasSet: `alias-${id}`,
  status,
  isDefault,
});

describe('resolveExecutableVersion', () => {
  it('selects the explicitly default version even when a newer version is approved', () => {
    const result = resolveExecutableVersion(
      [version('v1', 1, 'APPROVED', true), version('v2', 2, 'APPROVED')],
      version('fallback', 3, 'DRAFT'),
    );
    expect(result).toMatchObject({ id: 'v1', source: 'default' });
  });

  it('selects the highest numbered approved version when there is no default', () => {
    const result = resolveExecutableVersion(
      [version('v2', 2, 'APPROVED'), version('v4', 4, 'APPROVED'), version('v5', 5, 'DRAFT')],
      version('fallback', 5, 'DRAFT'),
    );
    expect(result).toMatchObject({ id: 'v4', content: 'content-v4', source: 'approved' });
  });

  it('uses the latest policy content when no version was approved', () => {
    const result = resolveExecutableVersion(
      [version('v1', 1, 'DRAFT')],
      version('latest', 2, 'DRAFT'),
    );
    expect(result).toMatchObject({ id: 'latest', source: 'latest' });
  });

  it('uses the newest saved draft as the unapproved fallback', () => {
    const result = resolveExecutableVersion(
      [version('v1', 1, 'DRAFT'), version('v2', 2, 'DRAFT')],
      version('v1', 1, 'DRAFT'),
    );
    expect(result).toMatchObject({ id: 'v2', source: 'latest' });
  });
});

describe('isCachedVersionCurrent', () => {
  it('rejects cached metadata from a different executable version', () => {
    expect(isCachedVersionCurrent(2, 1)).toBe(false);
    expect(isCachedVersionCurrent(2, 2)).toBe(true);
  });
});

describe('hydrateExecutableVersion', () => {
  it('不读取版本内容即可完成缓存命中校验', async () => {
    const lightweight: ExecutableVersionCandidate = { id: 'v2', version: 2, status: 'APPROVED', isDefault: true };
    const selected = resolveExecutableVersion([lightweight], lightweight);
    const loadVersion = vi.fn();

    expect(isCachedVersionCurrent(2, selected.version)).toBe(true);
    expect(loadVersion).not.toHaveBeenCalled();
  });

  it('选中非当前版本时只加载该版本一次', async () => {
    const current = version('v3', 3, 'DRAFT');
    const selected = resolveExecutableVersion(
      [{ id: 'v1', version: 1, status: 'APPROVED', isDefault: true }],
      current,
    );
    const loadVersion = vi.fn(async (number: number) => version(`v${number}`, number, 'APPROVED', true));

    const result = await hydrateExecutableVersion(selected, current, loadVersion);

    expect(loadVersion).toHaveBeenCalledTimes(1);
    expect(loadVersion).toHaveBeenCalledWith(1);
    expect(result).toMatchObject({ id: 'v1', version: 1, content: 'content-v1' });
  });
});
