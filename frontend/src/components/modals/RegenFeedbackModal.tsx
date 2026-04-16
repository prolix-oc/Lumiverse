import { MessageSquareText } from 'lucide-react'
import { InputPromptModal } from '@/components/shared/InputPromptModal'

interface RegenFeedbackModalProps {
  onSubmit: (feedback: string) => void
  onSkip: () => void
  onCancel: () => void
  defaultValue?: string
}

export default function RegenFeedbackModal({
  onSubmit,
  onSkip,
  onCancel,
  defaultValue,
}: RegenFeedbackModalProps) {
  return (
    <InputPromptModal
      isOpen={true}
      title="Regeneration Feedback"
      message="Provide guidance for the next generation. This will be included as an OOC instruction."
      placeholder="e.g. Make the response shorter, focus on dialogue, change the tone to be more playful..."
      defaultValue={defaultValue}
      multiline
      submitLabel="Regenerate"
      secondaryLabel="Skip"
      onSubmit={onSubmit}
      onSecondary={onSkip}
      onCancel={onCancel}
      icon={<MessageSquareText size={16} />}
    />
  )
}
