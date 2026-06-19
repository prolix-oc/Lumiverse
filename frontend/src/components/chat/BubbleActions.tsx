import { useState, useCallback } from 'react'
import { useTranslation } from 'react-i18next'

import { Copy, Check, Pencil, Trash2, EyeOff, Eye, BarChart3, Volume2, Square } from 'lucide-react'
import { IconGitFork } from '@tabler/icons-react'
import { copyTextToClipboard } from '@/lib/clipboard'
import styles from './BubbleActions.module.css'

interface BubbleActionsProps {
  onEdit: () => void
  onDelete: () => void
  onToggleHidden: () => void
  onFork: () => void
  onPromptBreakdown?: () => void
  onPlay?: () => void
  isPlaying?: boolean
  /** True while a save-first TTS regen is in flight — swaps the play
   *  button to a cancel affordance. */
  isGenerating?: boolean
  /** True when this message already has a persisted audio attachment —
   *  changes the play tooltip to "Regenerate". */
  hasSavedAudio?: boolean
  isHidden: boolean
  content: string
  className?: string
}

export default function BubbleActions({
  onEdit,
  onDelete,
  onToggleHidden,
  onFork,
  onPromptBreakdown,
  onPlay,
  isPlaying,
  isGenerating,
  hasSavedAudio,
  isHidden,
  content,
  className,
}: BubbleActionsProps) {
  const { t } = useTranslation('chat')
  const { t: tc } = useTranslation('common')
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

  return (
    <div data-component="BubbleActions" className={className ? `${styles.pill} ${className}` : styles.pill}>
      <button type="button" onClick={handleCopy} title={tc('actions.copy')} aria-label={tc('actions.copy')}>
        {copied ? <Check size={13} /> : <Copy size={13} />}
      </button>
      <button type="button" onClick={onEdit} title={tc('actions.edit')} aria-label={tc('actions.edit')}>
        <Pencil size={13} />
      </button>
      {onPlay && (
        <button
          type="button"
          onClick={onPlay}
          title={playLabel}
          aria-label={playLabel}
          aria-pressed={isPlaying}
        >
          {showStopIcon ? <Square size={13} /> : <Volume2 size={13} />}
        </button>
      )}
      <button
        type="button"
        onClick={onToggleHidden}
        title={isHidden ? t('messageActions.unhideFromAi') : t('messageActions.hideFromAi')}
        aria-label={isHidden ? t('messageActions.unhide') : t('messageActions.hide')}
      >
        {isHidden ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
      <button type="button" onClick={onFork} title={t('messageActions.fork')} aria-label={t('messageActions.forkAria')}>
        <IconGitFork size={13} />
      </button>
      {onPromptBreakdown && (
        <button type="button" onClick={onPromptBreakdown} title={t('messageActions.promptBreakdown')} aria-label={t('messageActions.promptBreakdown')}>
          <BarChart3 size={13} />
        </button>
      )}
      <button type="button" onClick={onDelete} title={tc('actions.delete')} aria-label={tc('actions.delete')}>
        <Trash2 size={13} />
      </button>
    </div>
  )
}
