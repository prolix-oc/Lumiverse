import { MessageSquareText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { InputPromptModal } from '@/components/shared/InputPromptModal'
import { Toggle } from '@/components/shared/Toggle'
import { useStore } from '@/store'

interface RegenFeedbackModalProps {
  onSubmit: (feedback: string) => void
  onSaveDraft: (feedback: string) => void
  onSkip: () => void
  onCancel: () => void
  defaultValue?: string
}

const PREVIOUS_GENERATION_TAG =
  '[REJECTED MESSAGE: The last message was rejected due to quality issues. The feedback regarding the quality of this message will follow it. Previous message for reference: {{regeneratedMessage}}]'

export default function RegenFeedbackModal({
  onSubmit,
  onSaveDraft,
  onSkip,
  onCancel,
  defaultValue,
}: RegenFeedbackModalProps) {
  const { t } = useTranslation('modals')
  const regenFeedback = useStore((s) => s.regenFeedback)
  const setSetting = useStore((s) => s.setSetting)

  const setIncludePreviousGeneration = (checked: boolean) => {
    setSetting('regenFeedback', { ...regenFeedback, includePreviousGeneration: checked })
  }

  const handleSubmit = (feedback: string) => {
    onSaveDraft(feedback)
    if (regenFeedback.includePreviousGeneration) {
      onSubmit(`${PREVIOUS_GENERATION_TAG}\n\n${feedback}`)
    } else {
      onSubmit(feedback)
    }
  }

  const handleSkip = () => {
    onSaveDraft('')
    onSkip()
  }

  return (
    <InputPromptModal
      isOpen={true}
      title={t('regenFeedback.title')}
      message={t('regenFeedback.message')}
      placeholder={t('regenFeedback.placeholder')}
      defaultValue={defaultValue}
      multiline
      submitLabel={t('regenFeedback.submit')}
      secondaryLabel={t('regenFeedback.skip')}
      onSubmit={handleSubmit}
      onSecondary={handleSkip}
      onCancel={onCancel}
      icon={<MessageSquareText size={16} />}
      footer={
        <Toggle.Checkbox
          checked={regenFeedback.includePreviousGeneration}
          onChange={setIncludePreviousGeneration}
          label={t('regenFeedback.usePreviousGeneration')}
        />
      }
    />
  )
}
