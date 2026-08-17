import { useStore } from '@/store'
import { persistKey } from '@/store/slices/settings'
import {
  PRODUCTIVITY_FEATURE_FLAGS,
  readProductivityFlag,
  type ProductivityFeatureFlag,
} from '@/lib/spindle/productivity-feature-toggles'
import styles from './ProductivitySettings.module.css'

const FLAG_COPY: Record<ProductivityFeatureFlag, { title: string; description: string }> = {
  showEmbeddingFallbackUi: {
    title: 'Embedding fallback profiles',
    description: 'Show the extra embeddings card for primary and fallback connection profiles.',
  },
  showCortexSecondaryUi: {
    title: 'Cortex secondary connections',
    description: 'Show extraction and summary secondary connection pickers in Memory Cortex.',
  },
  showEditAndSend: {
    title: 'Edit and Send',
    description: 'Show the Edit and Send action when rewriting a chat message.',
  },
  enableToolbarIconReorder: {
    title: 'Drag to reorder toolbar icons',
    description: 'Hold an icon on the live toolbar to reorder. Turn off to keep clicks only.',
  },
}

export default function ProductivityFeatureToggles() {
  const showEmbeddingFallbackUi = useStore((state) => readProductivityFlag(state, 'showEmbeddingFallbackUi'))
  const showCortexSecondaryUi = useStore((state) => readProductivityFlag(state, 'showCortexSecondaryUi'))
  const showEditAndSend = useStore((state) => readProductivityFlag(state, 'showEditAndSend'))
  const enableToolbarIconReorder = useStore((state) => readProductivityFlag(state, 'enableToolbarIconReorder'))
  const flags = { showEmbeddingFallbackUi, showCortexSecondaryUi, showEditAndSend, enableToolbarIconReorder }
  const setFlag = (key: ProductivityFeatureFlag, value: boolean) => {
    useStore.setState({ [key]: value } as Record<ProductivityFeatureFlag, boolean>)
    persistKey(key, value, 'user-interaction')
  }

  return (
    <section
      className={styles.card}
      aria-labelledby="productivity-feature-toggles-title"
      data-spindle-mount="settings_section"
      data-spindle-scope="settings-section:productivity:feature-toggles"
    >
      <div className={styles.cardHeader}>
        <div>
          <h3 id="productivity-feature-toggles-title">Optional surfaces</h3>
          <p>Hide extra fallback and edit-send controls without removing their settings.</p>
        </div>
      </div>
      <div className={styles.cardBody}>
        {PRODUCTIVITY_FEATURE_FLAGS.map((key) => {
          const copy = FLAG_COPY[key]
          return (
            <div className={styles.checkField} key={key} data-productivity-feature-flag={key}>
              <label htmlFor={`productivity-feature-${key}`}>
                <input
                  id={`productivity-feature-${key}`}
                  type="checkbox"
                  checked={flags[key]}
                  onChange={(event) => setFlag(key, event.target.checked)}
                  aria-label={copy.title}
                />
                <span>
                  {copy.title}
                  <small>{copy.description}</small>
                </span>
              </label>
            </div>
          )
        })}
      </div>
    </section>
  )
}
