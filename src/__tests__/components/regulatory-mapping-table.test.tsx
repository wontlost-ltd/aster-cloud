// 法规对照表（ADR 0045 §5）：状态徽标、按 locale 取条款标题、证据条数与空态。
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import {
  RegulatoryMappingPanel,
  RegulatoryMappingTable,
  type RegulatoryMappingLabels,
} from '@/components/evidence/regulatory-mapping-table';
import type { RegulatoryMapping } from '@/services/evidence/regulatory-mapping';

const labels: RegulatoryMappingLabels = {
  profiles: 'profiles-label', notAvailable: 'not-available', noFrameworks: 'no-frameworks', registryVersion: 'registry {version}', disclaimer: 'disclaimer',
  columns: { clause: 'clause', title: 'title', status: 'status', evidence: 'evidence' },
  status: { evidenced: 'S-evidenced', partial: 'S-partial', none: 'S-none' },
};

const t = (en: string, zh: string) => ({ en, zh, de: en });
const mapping: RegulatoryMapping = {
  registryVersion: '1.0.0',
  frameworks: [{
    framework: 'EU_AI_ACT', article: '14', control: 'EU_AI_ACT:ART14',
    clauses: [
      { clause: '14(1)', title: t('Designed for effective human oversight', '设计上可被有效人工监督'), status: 'evidenced',
        evidence: [{ executionId: 'e1', field: 'controls' }, { executionId: 'e2', field: 'controls' }] },
      { clause: '14(4)(b)', title: t('Awareness of automation bias', '意识到自动化偏见'), status: 'none', evidence: [] },
      { clause: '14(4)(d)', title: t('Decide not to use or override the output', '决定不使用或推翻输出'), status: 'partial',
        evidence: [{ executionId: 'e3', field: 'reviewers' }] },
    ],
  }],
};

afterEach(cleanup);

describe('RegulatoryMappingTable', () => {
  it('按 locale 渲染标题、三种状态与证据条数', () => {
    render(<RegulatoryMappingTable mapping={mapping} locale="zh" labels={labels} />);
    expect(screen.getByText('决定不使用或推翻输出')).toBeTruthy();
    expect(screen.getByText('S-evidenced')).toBeTruthy();
    expect(screen.getByText('S-partial')).toBeTruthy();
    expect(screen.getByText('S-none')).toBeTruthy();
    expect(screen.getByText('registry 1.0.0')).toBeTruthy();
    expect(screen.getByTestId('evidence-count-14(1)').textContent).toBe('2');
  });

  it('hi 等未覆盖的 locale 回退英文标题', () => {
    render(<RegulatoryMappingTable mapping={mapping} locale="hi" labels={labels} />);
    expect(screen.getByText('Awareness of automation bias')).toBeTruthy();
  });

  it('带 profilesUsed 时在顶部列出档案标题（按 locale）', () => {
    const profilesUsed = [{ id: 'eu-ai-act-high-risk', title: t('EU AI Act high-risk system', '欧盟人工智能法高风险系统') }];
    render(<RegulatoryMappingTable mapping={{ ...mapping, profilesUsed }} locale="zh" labels={labels} />);
    expect(screen.getByText('profiles-label')).toBeTruthy();
    expect(screen.getByText('欧盟人工智能法高风险系统')).toBeTruthy();
  });

  it('无 profilesUsed（v4）或为空时不显示档案行', () => {
    render(<RegulatoryMappingTable mapping={{ ...mapping, profilesUsed: [] }} locale="en" labels={labels} />);
    expect(screen.queryByText('profiles-label')).toBeNull();
  });

  it('mapping 为 null 显示不含对照', () => {
    render(<RegulatoryMappingTable mapping={null} locale="en" labels={labels} />);
    expect(screen.getByText('not-available')).toBeTruthy();
  });

  it('v4 但无带条款的已登记控制点 → 显示空态而非空表', () => {
    render(<RegulatoryMappingTable mapping={{ registryVersion: '1.0.0', frameworks: [] }} locale="en" labels={labels} />);
    expect(screen.getByText('no-frameworks')).toBeTruthy();
    expect(screen.getByText('registry 1.0.0')).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
  });
});

describe('RegulatoryMappingPanel', () => {
  const panelLabels = { ...labels, loading: 'loading', loadFailed: 'load-failed' };

  it('加载失败显示 loadFailed，而不是「不含对照」', () => {
    render(<RegulatoryMappingPanel state="error" locale="en" labels={panelLabels} />);
    expect(screen.getByText('load-failed')).toBeTruthy();
    expect(screen.queryByText('not-available')).toBeNull();
  });

  it('请求中显示 loading；取到后渲染对照表', () => {
    const { rerender } = render(<RegulatoryMappingPanel state="loading" locale="en" labels={panelLabels} />);
    expect(screen.getByText('loading')).toBeTruthy();
    rerender(<RegulatoryMappingPanel state={mapping} locale="en" labels={panelLabels} />);
    expect(screen.getByText('registry 1.0.0')).toBeTruthy();
  });

  it('接口如实返回 null（v1–v3）显示不含对照', () => {
    render(<RegulatoryMappingPanel state={null} locale="en" labels={panelLabels} />);
    expect(screen.getByText('not-available')).toBeTruthy();
  });
});
