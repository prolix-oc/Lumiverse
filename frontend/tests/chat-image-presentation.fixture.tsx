import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { DEFAULT_CHAT_IMAGE_TARGETS } from '@/lib/chatImagePresentation'
import { useStore } from '@/store'
import ChatImageSettings from '@/components/settings/ChatImageSettings'
import MessageContent from '@/components/chat/MessageContent'
import MessageAttachments from '@/components/chat/MessageAttachments'
import settingsStyles from '@/components/modals/SettingsModal.module.css'
import bubbleStyles from '@/components/chat/BubbleMessage.module.css'
import minimalStyles from '@/components/chat/MinimalMessage.module.css'
import '@/theme/reset.css'

const content = `![Markdown](/fixture-wide.svg)

[![Linked Markdown](/fixture-wide.svg)](https://example.test/)

![](/fixture-wide.svg)

<img src="/fixture-wide.svg" alt="Raw HTML" width="120" height="80" style="width:120px;max-height:80px">

<img src="/fixture-tall.svg" alt="XML image" />

<img="Portrait">

<img src="PortraitSource" alt="Asset source">

<div><style>.fixture-card { color: inherit; }</style><div class="fixture-card">

![Island Markdown](/fixture-wide.svg)

<img src="/fixture-wide.svg" alt="Island HTML" style="width:120px;max-height:80px" />
</div></div>`

useStore.setState({
  chatImageSize: 'default', chatImageAlignment: 'left', chatImageTargets: { ...DEFAULT_CHAT_IMAGE_TARGETS },
  ...JSON.parse(localStorage.getItem('image-preferences') || '{}'),
  activeChatId: 'fixture-chat', activeCharacterId: null, activeGroupCharacterId: null,
  characters: [], groupCharacterIds: [], isGroupChat: false, personas: [],
  messages: [], regexScripts: [], oocEnabled: false, lumiaOOCStyle: 'card',
  expandedLongMessageKeys: [], longMessageCollapseEnabled: false,
  setSetting(key: string, value: unknown) {
    useStore.setState({ [key]: value })
    const { chatImageSize, chatImageAlignment, chatImageTargets } = useStore.getState()
    localStorage.setItem('image-preferences', JSON.stringify({ chatImageSize, chatImageAlignment, chatImageTargets }))
  },
} as never)

function Fixture() {
  const [open, setOpen] = useState(true)
  const [mode, setMode] = useState('minimal')
  const [mounted, setMounted] = useState(true)
  return <>
    {open ? <div className={settingsStyles.overlay}>
      <section className={settingsStyles.modal} aria-label="Settings">
        <header className={settingsStyles.header}><h2>Inline Images</h2><button onClick={() => setOpen(false)}>Close settings</button></header>
        <div className={settingsStyles.body}><div className={settingsStyles.content}><ChatImageSettings /></div></div>
      </section>
    </div> : <button onClick={() => setOpen(true)}>Reopen settings</button>}
    <button onClick={() => setMode(mode === 'minimal' ? 'bubble' : 'minimal')}>Switch display mode</button>
    <button onClick={() => setMounted(!mounted)}>Toggle message</button>
    {mounted && <div id="message" className={mode === 'minimal' ? minimalStyles.bubble : bubbleStyles.content}>
      <MessageContent content={content} isUser={false} userName="Reader" chatId="fixture-chat" messageId="fixture-message" risuAssetMapOverride={{ Portrait: 'fixture-asset', PortraitSource: 'fixture-asset' }} />
      <MessageAttachments chatId="fixture-chat" messageId="fixture-message" attachments={[{ type: 'image', image_id: 'fixture-attachment', original_filename: 'Attachment', width: 1200, height: 600 }]} />
      <MessageAttachments isUser chatId="fixture-chat" messageId="fixture-message" attachments={[{ type: 'image', image_id: 'fixture-user', original_filename: 'User attachment' }]} />
    </div>}
    <div id="profile"><MessageContent content="![Profile preview](/fixture-wide.svg)" isUser={false} userName="Reader" disableInterceptors /></div>
    <div id="videos"><MessageAttachments isUser chatId="fixture-chat" messageId="fixture-videos" attachments={[
      { type: 'video', image_id: 'fixture-video-1', original_filename: 'First video' },
      { type: 'video', image_id: 'fixture-video-2', original_filename: 'Second video' },
    ]} /></div>
    <div id="multiple-images"><MessageAttachments chatId="fixture-chat" messageId="fixture-images" attachments={[
      { type: 'image', image_id: 'fixture-first', original_filename: 'First attachment', width: 1200, height: 600 },
      { type: 'image', image_id: 'fixture-second', original_filename: 'Second attachment', width: 1200, height: 600 },
    ]} /></div>
  </>
}
createRoot(document.getElementById('root')!).render(<Fixture />)
