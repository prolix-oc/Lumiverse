import { Pencil, Trash2, Copy, Check, BarChart3, EyeOff, Eye, Volume2, Square } from 'lucide-react'
import { IconGitFork } from '@tabler/icons-react'
import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/shared/FormComponents'
import { copyTextToClipboard } from '@/lib/clipboard'
import styles from './MessageActions.module.css'

interface MessageActionsProps {
  onEdit: () => void
  onDelete: () => void
  onToggleHidden: () => void
  onFork: () => void
  onPromptBreakdown?: () => void
  onPlay?: () => void
  isPlaying?: boolean
  /**
   * True while a save-first TTS regen is in flight. Swaps the play
   * button to a stop affordance with a "Cancel TTS generation" label so
   * the user can abort a long synth they no longer want.
   */
  isGenerating?: boolean
  /** True when this message already has a persisted audio attachment —
   *  changes the play tooltip from "Play with TTS" to "Regenerate". */
  hasSavedAudio?: boolean
  isUser: boolean
  isHidden: boolean
  content: string
}

export default function MessageActions({
  onEdit,
  onDelete,
  onToggleHidden,
  onFork,
  onPromptBreakdown,
  onPlay,
  isPlaying,
  isGenerating,
  hasSavedAudio,
  isUser,
  isHidden,
  content,
}: MessageActionsProps) {
  const { t } = useTranslation('chat')
  const [copied, setCopied] = useState(false)

  const handleCopy = useCallback(() => {
    copyTextToClipboard(content).catch(console.error)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }, [content])

  const playLabel = isGenerating
    ? t('messageActions.cancelTtsGeneration')
    : isPlaying
      ? t('messageActions.stopPlayback')
      : hasSavedAudio
        ? t('messageActions.regenerateTtsAudio')
        : t('messageActions.playTts')
  const showStopIcon = !!(isGenerating || isPlaying)
  const hideLabel = isHidden ? t('messageActions.unhideFromAi') : t('messageActions.hideFromAi')
  const hideAria = isHidden ? t('messageActions.unhide') : t('messageActions.hide')

  return (
    <div className={styles.actions}>
      <Button size="icon-sm" variant="ghost" onClick={onEdit} title={t('messageActions.edit')} aria-label={t('messageActions.edit')}>
        <Pencil size={13} />
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={handleCopy} title={t('messageActions.copy')} aria-label={t('messageActions.copy')}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </Button>
      {onPlay && (
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onPlay}
          title={playLabel}
          aria-label={playLabel}
          aria-pressed={isPlaying}
        >
          {showStopIcon ? <Square size={13} /> : <Volume2 size={13} />}
        </Button>
      )}
      <Button
        size="icon-sm"
        variant="ghost"
        onClick={onToggleHidden}
        title={hideLabel}
        aria-label={hideAria}
      >
        {isHidden ? <Eye size={13} /> : <EyeOff size={13} />}
      </Button>
      <Button size="icon-sm" variant="ghost" onClick={onFork} title={t('messageActions.fork')} aria-label={t('messageActions.forkAria')}>
        <IconGitFork size={13} />
      </Button>
      {onPromptBreakdown && (
        <Button size="icon-sm" variant="ghost" onClick={onPromptBreakdown} title={t('messageActions.promptBreakdown')} aria-label={t('messageActions.promptBreakdown')}>
          <BarChart3 size={13} />
        </Button>
      )}
      <Button size="icon-sm" variant="danger-ghost" onClick={onDelete} title={t('messageActions.delete')} aria-label={t('messageActions.delete')}>
        <Trash2 size={13} />
      </Button>
    </div>
  )
}
