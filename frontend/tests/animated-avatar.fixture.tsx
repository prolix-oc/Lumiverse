import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { initI18n } from '@/i18n'
import CharacterCard from '@/components/panels/character-browser/CharacterCard'
import HomepageLibraryCardImage from '@/components/landing/HomepageLibraryCardImage'
import ImageCropModal from '@/components/shared/ImageCropModal'
import useImageCropFlow from '@/hooks/useImageCropFlow'
import { getCharacterAvatarLargeUrlById } from '@/lib/avatarUrls'
import '@/theme/variables.css'
import '@/theme/reset.css'

await initI18n()

function Fixture() {
  const [saved, setSaved] = useState<File | null>(null)
  const [preview, setPreview] = useState('')
  const { openCropFlow, cropModalProps } = useImageCropFlow((file) => {
    setSaved(file)
    setPreview(URL.createObjectURL(file))
  })
  return <main style={{ padding: 20 }}>
    <div style={{ display: 'flex', gap: 20 }}>
      {['apng', 'webp'].map(id => <section key={id} style={{ width: 150 }}>
        <h2>{id} gallery</h2>
        <CharacterCard character={{ id, image_id: id, name: id, tags: [] } as any} isFavorite={false} onOpen={() => {}} onToggleFavorite={() => {}} />
        <h2>{id} landing</h2>
        <div style={{ width: 150, height: 150 }} data-testid={`${id}-landing`}>
          <HomepageLibraryCardImage src={getCharacterAvatarLargeUrlById(id, id)} alt={`${id} landing`} />
        </div>
      </section>)}
    </div>
    <label>Upload avatar<input type="file" onChange={event => event.target.files?.[0] && openCropFlow(event.target.files[0])} /></label>
    {saved && <><output>{saved.name} {saved.type}</output><img alt="Saved crop" src={preview} style={{ width: 100, height: 100 }} /></>}
    <ImageCropModal {...cropModalProps} />
  </main>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
