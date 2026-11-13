import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { useTranslation } from 'react-i18next'
import { charactersApi } from '@/api/characters'
import { startCharacterChat } from '@/lib/characterChat'

/** Only a deliberate widget tap reaches this route; refresh never creates chats. */
export default function WidgetCharacterPage() {
  const { id = '' } = useParams()
  const navigate = useNavigate()
  const { t } = useTranslation('common')
  const started = useRef<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) { setFailed(true); return }
    void charactersApi.get(id).then(async character => {
      if (cancelled || started.current === id) return
      started.current = id
      await startCharacterChat(character, path => { if (!cancelled) void navigate(path, { replace: true }) })
    }).catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [id, navigate])
  return <main style={{ padding: '2rem' }}>
    <p>{failed ? t('widgets.unavailable', { defaultValue: 'This character is unavailable.' }) : t('widgets.opening', { defaultValue: 'Opening your character…' })}</p>
    <button type="button" onClick={() => void navigate('/characters', { replace: true })}>{t('widgets.back', { defaultValue: 'Back to characters' })}</button>
  </main>
}
