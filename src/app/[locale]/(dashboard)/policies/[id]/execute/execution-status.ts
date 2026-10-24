export function executionStatus(hasEngineError: boolean, errorMessage?: string | null): 'completed' | 'error' {
  return hasEngineError || Boolean(errorMessage) ? 'error' : 'completed';
}
