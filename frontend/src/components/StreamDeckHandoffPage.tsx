import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router'
import { openChatInExistingLumiverseTab } from '@/lib/streamDeckHandoff'

export default function StreamDeckHandoffPage() {
  const { chatId = '' } = useParams()
  const navigate = useNavigate()
  const [message, setMessage] = useState('Opening chat…')

  useEffect(() => {
    let cancelled = false

    void openChatInExistingLumiverseTab(chatId).then(handled => {
      if (cancelled) return
      if (!handled) {
        void navigate(`/chat/${encodeURIComponent(chatId)}`, { replace: true })
        return
      }

      setMessage('Chat opened in your existing Lumiverse tab. You can close this page.')
      window.close()
    })

    return () => { cancelled = true }
  }, [chatId, navigate])

  return <main style={{ padding: '2rem', color: 'var(--text-primary)' }}>{message}</main>
}
