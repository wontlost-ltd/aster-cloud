'use client';

import { useTranslations } from 'next-intl';
import { Card, CardBody, Stack } from '@/components/ui';
import { ConditionFunnelPanel } from './condition-funnel-panel';

/**
 * 策略决策分析区（当前只挂 Phase 1 条件漏斗）。
 *
 * <p>存在的理由：面板自带一大票文案，若按详情页现有做法把每个 key 摊平到
 * `page.tsx` 的预渲染 translations 对象里，那个对象会迅速失控。这里改用
 * `useTranslations` 在客户端取——面板本就是 `'use client'`，没有额外代价。
 *
 * <p><b>What-if 面板不在这里</b>（ADR 0034）：它挂在**版本比较**面板里
 * （{@code version-compare-panel.tsx}），因为输入天然在那儿——
 * 要比较的两个版本就是 compare 的 left/right。
 * 上面的 diff 回答「源码改了什么」，What-If 回答「决策会怎么变」，
 * 是同一个问题的两面；放在一起用户不必跨区拼凑上下文。
 *
 * <p>本区保留「策略决策分析」语义（条件漏斗），与「版本比较」是两件事。
 */
export function PolicyAnalyticsSection({
  policyId,
  currentVersion,
}: {
  policyId: string;
  currentVersion: number;
}) {
  const t = useTranslations('conditionFunnel');
  const funnelLabels = {
    title: t('title'),
    subtitle: t('subtitle'),
    loading: t('loading'),
    empty: t('empty'),
    emptyHint: t('emptyHint'),
    sampleNote: t('sampleNote'),
    coverageNote: t('coverageNote'),
    neverMatchedTitle: t('neverMatchedTitle'),
    neverMatchedHint: t('neverMatchedHint'),
    truncatedNote: t('truncatedNote'),
    evaluated: t('evaluated'),
    matched: t('matched'),
    loadFailed: t('loadFailed'),
  };

  return (
    <Stack gap={6}>
      <Card>
        <CardBody className="pt-4">
          <ConditionFunnelPanel
            policyId={policyId}
            version={currentVersion}
            labels={funnelLabels}
          />
        </CardBody>
      </Card>
    </Stack>
  );
}
