/**
 * auto-upgrade.yml 拉取模型的决策逻辑：版本解析、提前退出（已最新 / PR 已开 / latest 更旧）、
 * 以及 lsp-package.json 钉版同步。
 */
import { describe, it, expect, vi } from 'vitest';
import {
  normalizeVersion,
  compareVersions,
  branchFor,
  decideUpgrade,
  bumpPin,
  DEP,
  SECONDARY_PINS,
} from '../../../scripts/resolve-aster-lang-upgrade.mjs';

const noPr = () => false;

describe('normalizeVersion', () => {
  it('strips leading v and whitespace', () => {
    expect(normalizeVersion('v1.0.32')).toBe('1.0.32');
    expect(normalizeVersion(' 1.0.32 ')).toBe('1.0.32');
    expect(normalizeVersion('1.1.0-rc.1')).toBe('1.1.0-rc.1');
  });

  it('rejects malformed or shell-unsafe input', () => {
    for (const bad of ['', 'latest', '1.0', '1.0.32;rm -rf /', '^1.0.32', undefined]) {
      expect(normalizeVersion(bad as string)).toBeNull();
    }
  });
});

describe('compareVersions', () => {
  it('orders numerically, not lexically', () => {
    expect(compareVersions('1.0.10', '1.0.9')).toBe(1);
    expect(compareVersions('1.0.9', '1.0.10')).toBe(-1);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });

  it('treats a prerelease as older than its release', () => {
    expect(compareVersions('1.1.0-rc.1', '1.1.0')).toBe(-1);
    expect(compareVersions('1.1.0', '1.1.0-rc.1')).toBe(1);
  });
});

describe('decideUpgrade', () => {
  it('scheduled run: latest equals pin → skip as already up to date', () => {
    const r = decideUpgrade({ requested: '', latest: '1.0.31', pinned: '1.0.31', isPrOpen: noPr });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/already up to date/);
  });

  it('scheduled run: newer latest → upgrade on deps/aster-lang-ts-v<version>', () => {
    const r = decideUpgrade({ requested: '', latest: '1.0.32', pinned: '1.0.31', isPrOpen: noPr });
    expect(r).toMatchObject({ action: 'upgrade', version: '1.0.32', branch: 'deps/aster-lang-ts-v1.0.32' });
  });

  it('skips when a PR for that version is already open (keyed by branch name)', () => {
    const isPrOpen = vi.fn((b: string) => b === branchFor('1.0.32'));
    const r = decideUpgrade({ requested: '', latest: '1.0.32', pinned: '1.0.31', isPrOpen });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/already open/);
    expect(isPrOpen).toHaveBeenCalledWith('deps/aster-lang-ts-v1.0.32');
  });

  it('does not query open PRs when already up to date', () => {
    const isPrOpen = vi.fn(() => true);
    decideUpgrade({ requested: '', latest: '1.0.31', pinned: '1.0.31', isPrOpen });
    expect(isPrOpen).not.toHaveBeenCalled();
  });

  it('explicit version input wins over latest and accepts a v prefix', () => {
    const r = decideUpgrade({ requested: 'v1.0.33', latest: '1.0.32', pinned: '1.0.31', isPrOpen: noPr });
    expect(r).toMatchObject({ action: 'upgrade', version: '1.0.33' });
  });

  it('explicit version equal to pin → skip', () => {
    const r = decideUpgrade({ requested: 'v1.0.31', latest: '', pinned: '1.0.31', isPrOpen: noPr });
    expect(r.action).toBe('skip');
  });

  it('auto-resolved latest older than pin → skip (no automatic downgrade)', () => {
    const r = decideUpgrade({ requested: '', latest: '1.0.30', pinned: '1.0.31', isPrOpen: noPr });
    expect(r.action).toBe('skip');
    expect(r.reason).toMatch(/older than pinned/);
  });

  it('explicit downgrade is honoured', () => {
    const r = decideUpgrade({ requested: '1.0.30', latest: '', pinned: '1.0.31', isPrOpen: noPr });
    expect(r.action).toBe('upgrade');
  });

  it('tolerates a range prefix on the pin', () => {
    const r = decideUpgrade({ requested: '', latest: '1.0.31', pinned: '^1.0.31', isPrOpen: noPr });
    expect(r.action).toBe('skip');
  });

  it('throws on an invalid requested version or pin', () => {
    expect(() => decideUpgrade({ requested: 'nope', latest: '', pinned: '1.0.31', isPrOpen: noPr })).toThrow();
    expect(() => decideUpgrade({ requested: '', latest: '1.0.32', pinned: undefined, isPrOpen: noPr })).toThrow();
  });
});

describe('bumpPin (secondary pins such as lsp-package.json)', () => {
  const lsp = { name: 'aster-lsp-server', private: true, dependencies: { [DEP]: '1.0.31', ws: '^8.19.0' } };

  it('rewrites only the aster-lang-ts pin, exact (no range)', () => {
    const next = bumpPin(lsp, 'v1.0.32');
    expect(next.dependencies).toEqual({ [DEP]: '1.0.32', ws: '^8.19.0' });
    expect(next.name).toBe('aster-lsp-server');
    expect(lsp.dependencies[DEP]).toBe('1.0.31');
  });

  it('aster-cloud keeps lsp-package.json in the secondary pin set', () => {
    expect(SECONDARY_PINS).toEqual(['lsp-package.json']);
  });

  it('throws when the pin is missing or the version is invalid', () => {
    expect(() => bumpPin({ dependencies: {} }, '1.0.32')).toThrow();
    expect(() => bumpPin(lsp, 'latest')).toThrow();
  });
});
