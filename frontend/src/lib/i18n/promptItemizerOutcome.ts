type ChatTranslate = (key: string, options?: Record<string, unknown>) => string

export function formatPromptItemizerOutcomeReason(
  status: string,
  reason: string,
  t: ChatTranslate,
): string {
  return t('ownerInspection.ar007.outcomeReason', {
    status,
    reason: t(`ownerInspection.values.${reason}`, { defaultValue: reason }),
  })
}
