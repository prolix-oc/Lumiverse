import { useTranslation } from 'react-i18next'
import ConnectionManager from './ConnectionManager'
import DecisionConnectionManager from './decision-connections/DecisionConnectionManager'
import EmbeddingConnectionManager from './embedding-connections/EmbeddingConnectionManager'
import ImageGenConnectionManager from './image-gen-connections/ImageGenConnectionManager'
import STTConnectionManager from './stt-connections/STTConnectionManager'
import TTSConnectionManager from './tts-connections/TTSConnectionManager'
import { ConnectionSearchProvider } from './connection-manager/ConnectionSearch'
import styles from './ConnectionsPanel.module.css'

const SECTIONS = [
  ['decisionModels', DecisionConnectionManager],
  ['embeddings', EmbeddingConnectionManager],
  ['imageGeneration', ImageGenConnectionManager],
  ['speechToText', STTConnectionManager],
  ['textToSpeech', TTSConnectionManager],
] as const

export default function ConnectionsPanel() {
  const { t } = useTranslation('panels')
  return <div className={`connections-stack ${styles.panel}`}>
    <ConnectionSearchProvider>
      <ConnectionManager />
      {SECTIONS.map(([key, Manager]) => <section key={key} className={styles.section}>
        <h3 className={styles.heading}>{t(`connections.${key}`)}</h3>
        <Manager />
      </section>)}
    </ConnectionSearchProvider>
  </div>
}
