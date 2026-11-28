// Guard 孤儿通知铃铛文案（ADR 0065 §3.3）：四种语言两键齐备、非空，并含约定的占位符。
import { describe, it, expect } from 'vitest';
import { DEMO_SUPPLEMENT } from '@/i18n/demo-supplement';

const LOCALES = ['en', 'zh', 'de', 'hi'] as const;

describe('guard.orphans_detected 铃铛文案', () => {
  for (const locale of LOCALES) {
    it(`${locale}：两键非空，均含 {count}，团队键含 {tenantName}`, () => {
      const ns = DEMO_SUPPLEMENT[locale].notifications as Record<string, unknown>;
      const team = ns.guardOrphansDetected;
      const personal = ns.guardOrphansDetectedPersonal;
      expect(typeof team).toBe('string');
      expect(typeof personal).toBe('string');
      expect((team as string).trim()).not.toBe('');
      expect((personal as string).trim()).not.toBe('');
      expect(team).toContain('{count}');
      expect(personal).toContain('{count}');
      expect(team).toContain('{tenantName}');
      expect(personal).not.toContain('{tenantName}');
    });
  }
});
