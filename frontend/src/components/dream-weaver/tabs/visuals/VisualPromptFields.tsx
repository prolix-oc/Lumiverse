import {
  buildVisualMacroOptions,
  collectPromptMacroTokens,
} from '../../lib/visual-studio-model'
import type { VisualStudioModel } from '../../hooks/useVisualStudio'
import styles from './VisualPromptFields.module.css'

interface VisualPromptFieldsProps {
  visuals: VisualStudioModel
}

function appendToken(prompt: string, token: string): string {
  const trimmedPrompt = prompt.trim()
  if (!trimmedPrompt) return token
  if (trimmedPrompt.includes(token)) return prompt
  const needsComma = !/[,\s]$/.test(prompt)
  return `${prompt}${needsComma ? ', ' : ' '}${token}`
}

function getGenerateLabel(visuals: VisualStudioModel): string {
  if (visuals.generating) return 'Generating...'
  if (visuals.acceptedImageUrl || visuals.candidateImageUrl) return 'Generate Again'
  return 'Generate Portrait'
}

function getPromptHint(visuals: VisualStudioModel): string {
  switch (visuals.workspaceState) {
    case 'no_source':
      return 'Choose a source before generating.'
    case 'needs_workflow':
      return 'Import a workflow before generating.'
    case 'needs_mapping':
      return 'Map positive and negative prompt fields before generating.'
    case 'failed':
      return 'Adjust the prompts or settings, then try again.'
    default:
      return 'Positive and negative prompts stay inline so you can tune them without leaving the portrait view.'
  }
}

export function VisualPromptFields({ visuals }: VisualPromptFieldsProps) {
  const asset = visuals.selectedAsset
  const macroOptions = buildVisualMacroOptions(visuals.draft)

  if (!asset) return null

  return (
    <section className={styles.promptArea}>
      <div className={styles.promptBlock}>
        <div className={styles.promptHeader}>
          <span className={styles.promptLabel}>Positive Prompt</span>
          <div className={styles.promptTools}>
            <button
              type="button"
              className={styles.suggestButton}
              onClick={visuals.onSuggestTags}
              disabled={visuals.tagSuggestionLoading || !visuals.draft}
            >
              {visuals.tagSuggestionLoading ? 'Suggesting...' : 'Suggest Tags'}
            </button>
            {macroOptions.length > 0 && (
              <div className={styles.tokenRow}>
                {macroOptions.map((option) => (
                  <button
                    key={option.token}
                    type="button"
                    className={styles.token}
                    onClick={() =>
                      visuals.onUpdateAsset(asset.id, {
                        prompt: appendToken(asset.prompt, option.token),
                        macro_tokens: collectPromptMacroTokens(appendToken(asset.prompt, option.token)),
                      })
                    }
                  >
                    {option.token}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        {(visuals.pendingTagSuggestion || visuals.tagSuggestionError) && (
          <div className={styles.reviewSheet}>
            <div className={styles.reviewHeader}>
              <span className={styles.reviewLabel}>Suggested Tags</span>
              <span className={styles.reviewHint}>Replaces the previous suggested tag block only</span>
            </div>
            {visuals.pendingTagSuggestion ? (
              <div className={styles.reviewPreview}>{visuals.pendingTagSuggestion}</div>
            ) : null}
            {visuals.tagSuggestionError ? (
              <p className={styles.reviewError}>{visuals.tagSuggestionError}</p>
            ) : null}
            <div className={styles.reviewActions}>
              <button
                type="button"
                className={styles.reviewPrimary}
                onClick={visuals.onAcceptSuggestedTags}
                disabled={!visuals.pendingTagSuggestion}
              >
                Accept
              </button>
              <button
                type="button"
                className={styles.reviewSecondary}
                onClick={visuals.onRegenerateSuggestedTags}
                disabled={visuals.tagSuggestionLoading}
              >
                Regenerate
              </button>
              <button
                type="button"
                className={styles.reviewSecondary}
                onClick={visuals.onCancelSuggestedTags}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
        <textarea
          className={styles.textarea}
          rows={6}
          value={asset.prompt}
          onChange={(event) =>
            visuals.onUpdateAsset(asset.id, {
              prompt: event.target.value,
              macro_tokens: collectPromptMacroTokens(event.target.value),
            })
          }
          placeholder="Prompt details, macro tokens, and portrait direction..."
        />
      </div>

      <div className={styles.promptBlock}>
        <div className={styles.promptHeader}>
          <span className={styles.promptLabel}>Negative Prompt</span>
        </div>
        <textarea
          className={styles.textarea}
          rows={4}
          value={asset.negative_prompt}
          onChange={(event) =>
            visuals.onUpdateAsset(asset.id, {
              negative_prompt: event.target.value,
            })
          }
          placeholder="What to avoid in the result..."
        />
      </div>

      <div className={styles.generateRow}>
        <p className={styles.generateHint}>{getPromptHint(visuals)}</p>
        <button
          type="button"
          className={styles.generateButton}
          onClick={() => visuals.onGenerate()}
          disabled={!visuals.canGenerate || visuals.generating}
        >
          {getGenerateLabel(visuals)}
        </button>
      </div>
    </section>
  )
}
