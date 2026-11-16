'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Link } from '@/i18n/navigation';

const USE_CASE_IDS = ['finance', 'healthcare', 'ecommerce', 'insurance', 'legal', 'other'] as const;
const USE_CASE_ICONS: Record<typeof USE_CASE_IDS[number], string> = {
  finance: '🏦',
  healthcare: '🏥',
  ecommerce: '🛒',
  insurance: '📋',
  legal: '⚖️',
  other: '🔧',
};

const GOAL_IDS = ['pii', 'compliance', 'automation', 'team', 'integration'] as const;

interface Translations {
  brand: string;
  welcome: string;
  industryQuestion: string;
  goalsQuestion: string;
  continue: string;
  back: string;
  starting: string;
  getStarted: string;
  skipForNow: string;
  useCases: Record<typeof USE_CASE_IDS[number], string>;
  goals: Record<typeof GOAL_IDS[number], string>;
}

interface OnboardingContentProps {
  translations: Translations;
}

export function OnboardingContent({ translations: t }: OnboardingContentProps) {
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [selectedUseCase, setSelectedUseCase] = useState('');
  const [selectedGoals, setSelectedGoals] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const toggleGoal = (goalId: string) => {
    setSelectedGoals((prev) =>
      prev.includes(goalId) ? prev.filter((g) => g !== goalId) : [...prev, goalId]
    );
  };

  const handleComplete = async () => {
    setIsLoading(true);

    try {
      await fetch('/api/user/onboarding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useCase: selectedUseCase, goals: selectedGoals }),
      });
    } catch {
      // 即使保存失败也继续导航
    }

    router.push('/dashboard');
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-bg-subtle py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-lg w-full space-y-8">
        <div>
          <Link href="/" className="flex justify-center">
            <span className="text-3xl font-bold text-primary">{t.brand}</span>
          </Link>
          <h2 className="mt-6 text-center text-2xl font-bold text-fg">
            {t.welcome}
          </h2>

          {/* Progress */}
          <div className="mt-6 flex justify-center space-x-2">
            {[1, 2].map((s) => (
              <div
                key={s}
                className={`h-2 w-16 rounded-full ${
                  s <= step ? 'bg-primary' : 'bg-bg-muted'
                }`}
              />
            ))}
          </div>
        </div>

        {step === 1 && (
          <div className="space-y-6">
            <p className="text-center text-fg-muted">{t.industryQuestion}</p>

            <div className="grid grid-cols-2 gap-3">
              {USE_CASE_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSelectedUseCase(id)}
                  className={`flex items-center p-4 rounded-lg border-2 transition-colors ${
                    selectedUseCase === id
                      ? 'border-primary bg-primary-subtle'
                      : 'border-border hover:border-border-strong'
                  }`}
                >
                  <span className="text-2xl mr-3">{USE_CASE_ICONS[id]}</span>
                  <span className="text-sm font-medium text-fg">{t.useCases[id]}</span>
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setStep(2)}
              disabled={!selectedUseCase}
              className="w-full py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-primary-fg bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t.continue}
            </button>
          </div>
        )}

        {step === 2 && (
          <div className="space-y-6">
            <p className="text-center text-fg-muted">
              {t.goalsQuestion}
            </p>

            <div className="space-y-3">
              {GOAL_IDS.map((id) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => toggleGoal(id)}
                  className={`flex items-center w-full p-4 rounded-lg border-2 transition-colors ${
                    selectedGoals.includes(id)
                      ? 'border-primary bg-primary-subtle'
                      : 'border-border hover:border-border-strong'
                  }`}
                >
                  <div
                    className={`w-5 h-5 rounded border-2 mr-3 flex items-center justify-center ${
                      selectedGoals.includes(id)
                        ? 'bg-primary border-primary text-primary-fg'
                        : 'border-border-strong'
                    }`}
                  >
                    {selectedGoals.includes(id) && (
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  <span className="text-sm font-medium text-fg">{t.goals[id]}</span>
                </button>
              ))}
            </div>

            <div className="flex space-x-3">
              <button
                type="button"
                onClick={() => setStep(1)}
                className="flex-1 py-3 px-4 border border-border-strong rounded-md shadow-sm text-sm font-medium text-fg-muted bg-bg hover:bg-bg-subtle"
              >
                {t.back}
              </button>
              <button
                type="button"
                onClick={handleComplete}
                disabled={selectedGoals.length === 0 || isLoading}
                className="flex-1 py-3 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-primary-fg bg-primary hover:bg-primary-hover disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? t.starting : t.getStarted}
              </button>
            </div>
          </div>
        )}

        <p className="text-center text-sm text-fg-subtle">
          <Link href="/dashboard" className="text-primary hover:text-primary">
            {t.skipForNow}
          </Link>
        </p>
      </div>
    </div>
  );
}
