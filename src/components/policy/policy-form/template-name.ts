export function nextTemplateName(
  currentName: string,
  automaticName: string | null,
  nextAutomaticName: string,
): string {
  return !currentName || currentName === automaticName ? nextAutomaticName : currentName;
}
