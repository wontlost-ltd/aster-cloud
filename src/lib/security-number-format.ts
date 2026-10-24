export function formatSecurityCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatSecurityPercentage(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
}
