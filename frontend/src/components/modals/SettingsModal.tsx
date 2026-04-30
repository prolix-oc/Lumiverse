import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import { RefreshCw } from 'lucide-react'
import { CloseButton } from '@/components/shared/CloseButton'
import { Button } from '@/components/shared/FormComponents'
import NumericInput from '@/components/shared/NumericInput'
import { Toggle } from '@/components/shared/Toggle'
import { spinClass } from '@/components/shared/Spinner'
import { useStore } from '@/store'
import { spindleApi } from '@/api/spindle'
import { connectionsApi } from '@/api/connections'
import { embeddingsApi } from '@/api/embeddings'
import { imagesApi } from '@/api/images'
import { settingsApi } from '@/api/settings'
import { webSearchApi, type WebSearchSettingsInput, type WebSearchTestResponse } from '@/api/web-search'
import type { DrawerSettings, GuidedGeneration, QuickReplySet } from '@/types/store'
import type { EmbeddingConfig, ChatMemorySettings } from '@/types/api'
import type { WorldBookVectorPresetMode, WorldBookVectorSettings } from '@/types/world-book-vector-settings'
import AccountSettings from '@/components/settings/AccountSettings'
import UserManagement from '@/components/settings/UserManagement'
import MigrationSettings from '@/components/settings/MigrationSettings'
import TokenizerManager from '@/components/settings/TokenizerManager'
import Diagnostics from '@/components/settings/Diagnostics'
import NotificationSettings from '@/components/settings/NotificationSettings'
import MemoryCortexSettings from '@/components/settings/MemoryCortexSettings'
import OperatorPanel from '@/components/settings/OperatorPanel'
import VoiceSettings from '@/components/settings/VoiceSettings'
import McpServerSettings from '@/components/settings/mcp-servers/McpServerSettings'
import CollapsibleSection from '@/components/shared/CollapsibleSection'
import ModelCombobox from '@/components/panels/connection-manager/ModelCombobox'
import { getVisibleSettingsTabs } from '@/lib/settings-tab-registry'
import styles from './SettingsModal.module.css'
import clsx from 'clsx'

interface SettingsModalProps {
  onClose: () => void
}

export default function SettingsModal({ onClose }: SettingsModalProps) {
  const settingsActiveView = useStore((s) => s.settingsActiveView)
  const user = useStore((s) => s.user)
  const [activeView, setActiveView] = useState(settingsActiveView || 'display')

  const VIEWS = useMemo(() => getVisibleSettingsTabs(user?.role), [user?.role])

  useEffect(() => {
    if (!VIEWS.some((tab) => tab.id === activeView) && VIEWS.length > 0) {
      setActiveView(VIEWS[0].id)
    }
  }, [VIEWS, activeView])

  return createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <motion.div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        transition={{ duration: 0.15 }}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>Settings</h2>
          <CloseButton onClick={onClose} />
        </div>

        <div className={styles.body}>
          <nav className={styles.sidebar}>
            {VIEWS.map((tab) => {
              const Icon = tab.tabIcon
              return (
                <button
                  key={tab.id}
                  type="button"
                  className={clsx(styles.navBtn, activeView === tab.id && styles.navBtnActive)}
                  onClick={() => setActiveView(tab.id)}
                >
                  <Icon size={14} />
                  <span>{tab.shortName}</span>
                </button>
              )
            })}
          </nav>

          <div className={styles.content}>
            <SettingsView view={activeView} />
            <div
              className={clsx(
                styles.extensionMountHost,
                activeView !== 'extensions' && styles.extensionMountHostHidden
              )}
            >
              <div className={styles.extensionMount} data-spindle-mount="settings_extensions" />
            </div>
          </div>
        </div>
      </motion.div>
    </div>,
    document.body
  )
}

function SettingsView({ view }: { view: string }) {
  switch (view) {
    case 'account':
      return <AccountSettings />
    case 'display':
      return <DisplaySettings />
    case 'chat':
      return <ChatSettings />
    case 'extensions':
      return <ExtensionSettingsView />
    case 'guided':
      return <GuidedGenerationSettings />
    case 'quickReplies':
      return <QuickRepliesSettings />
    case 'extensionPools':
      return <ExtensionPoolSettings />
    case 'advanced':
      return <AdvancedSettings />
    case 'embeddings':
      return <EmbeddingsSettings />
    case 'webSearch':
      return <WebSearchSettings />
    case 'lumihub':
      return <LumiHubSettings />
    case 'tokenizers':
      return <TokenizerManager />
    case 'users':
      return <UserManagement />
    case 'memoryCortex':
      return <MemoryCortexSettings />
    case 'notifications':
      return <NotificationSettings />
    case 'voice':
      return <VoiceSettings />
    case 'mcpServers':
      return <McpServerSettings />
    case 'diagnostics':
      return <Diagnostics />
    case 'migration':
      return <MigrationSettings />
    case 'operator':
      return <OperatorPanel />
    default:
      return <div className={styles.placeholder}>Select a settings category</div>
  }
}

function createId(prefix: string) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function DisplaySettings() {
  const drawerSettings = useStore((s) => s.drawerSettings)
  const modalWidthMode = useStore((s) => s.modalWidthMode)
  const modalMaxWidth = useStore((s) => s.modalMaxWidth)
  const landingPageChatsDisplayed = useStore((s) => s.landingPageChatsDisplayed)
  const landingPageLayoutMode = useStore((s) => s.landingPageLayoutMode)
  const toastPosition = useStore((s) => s.toastPosition)
  const chatHeadsEnabled = useStore((s) => s.chatHeadsEnabled)
  const chatHeadsSize = useStore((s) => s.chatHeadsSize)
  const chatHeadsDirection = useStore((s) => s.chatHeadsDirection)
  const chatHeadsOpacity = useStore((s) => s.chatHeadsOpacity)
  const setSetting = useStore((s) => s.setSetting)

  const updateDrawer = (patch: Partial<DrawerSettings>) => {
    setSetting('drawerSettings', { ...drawerSettings, ...patch })
  }

  return (
    <div className={styles.settingsSection}>
      <h3 className={styles.sectionTitle}>Modal Width</h3>
      <p className={styles.helperText}>
        Constrain the maximum width of all modal dialogs. Affects settings, editors, and other popover panels.
      </p>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>MODAL WIDTH</label>
        <div className={styles.segmented}>
          {(['full', 'comfortable', 'compact', 'custom'] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              className={clsx(styles.segmentedBtn, modalWidthMode === preset && styles.segmentedBtnActive)}
              onClick={() => setSetting('modalWidthMode', preset)}
            >
              {preset === 'full' ? 'Full' : preset === 'comfortable' ? 'Comfortable' : preset === 'compact' ? 'Compact' : 'Custom'}
            </button>
          ))}
        </div>
      </div>

      {modalWidthMode === 'custom' && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>MAX WIDTH (px)</label>
          <div className={styles.rangeRow}>
            <input
              type="range"
              className={styles.rangeSlider}
              min={340}
              max={1400}
              step={10}
              value={modalMaxWidth}
              onChange={(e) => setSetting('modalMaxWidth', parseInt(e.target.value, 10))}
            />
            <span className={styles.rangeValue}>{modalMaxWidth}px</span>
          </div>
        </div>
      )}

      <h3 className={styles.sectionTitle} style={{ marginTop: 12 }}>Drawer</h3>

      <div className={styles.drawerRow}>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>DRAWER SIDE</label>
          <div className={styles.segmented}>
            <button
              type="button"
              className={clsx(styles.segmentedBtn, drawerSettings.side === 'left' && styles.segmentedBtnActive)}
              onClick={() => updateDrawer({ side: 'left' })}
            >
              Left
            </button>
            <button
              type="button"
              className={clsx(styles.segmentedBtn, drawerSettings.side === 'right' && styles.segmentedBtnActive)}
              onClick={() => updateDrawer({ side: 'right' })}
            >
              Right
            </button>
          </div>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel}>TAB POSITION</label>
          <div className={styles.rangeRow}>
            <input
              type="range"
              className={styles.rangeSlider}
              min={0}
              max={70}
              value={drawerSettings.verticalPosition}
              onChange={(e) => updateDrawer({ verticalPosition: parseInt(e.target.value, 10) })}
            />
            <span className={styles.rangeValue}>{drawerSettings.verticalPosition}%</span>
          </div>
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>TAB SIZE</label>
        <div className={styles.segmented}>
          <button
            type="button"
            className={clsx(styles.segmentedBtn, drawerSettings.tabSize === 'large' && styles.segmentedBtnActive)}
            onClick={() => updateDrawer({ tabSize: 'large' })}
          >
            Large
          </button>
          <button
            type="button"
            className={clsx(styles.segmentedBtn, drawerSettings.tabSize === 'compact' && styles.segmentedBtnActive)}
            onClick={() => updateDrawer({ tabSize: 'compact' })}
          >
            Compact
          </button>
        </div>
      </div>

      <Toggle.Checkbox
        checked={drawerSettings.showTabLabels ?? false}
        onChange={(checked) => updateDrawer({ showTabLabels: checked })}
        label="Show tab labels"
        hint="Display short names below each tab icon in the sidebar"
      />

      <div className={styles.field}>
        <label className={styles.fieldLabel}>PANEL WIDTH</label>
        <div className={styles.segmented}>
          <button
            type="button"
            className={clsx(styles.segmentedBtn, drawerSettings.panelWidthMode === 'default' && styles.segmentedBtnActive)}
            onClick={() => updateDrawer({ panelWidthMode: 'default' })}
          >
            Default
          </button>
          <button
            type="button"
            className={clsx(styles.segmentedBtn, drawerSettings.panelWidthMode === 'stChat' && styles.segmentedBtnActive)}
            onClick={() => updateDrawer({ panelWidthMode: 'stChat' })}
          >
            ST Chat
          </button>
          <button
            type="button"
            className={clsx(styles.segmentedBtn, drawerSettings.panelWidthMode === 'custom' && styles.segmentedBtnActive)}
            onClick={() => updateDrawer({ panelWidthMode: 'custom' })}
          >
            Custom
          </button>
        </div>
      </div>

      {drawerSettings.panelWidthMode === 'custom' && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>CUSTOM WIDTH (vw)</label>
          <NumericInput
            className={styles.numberInput}
            min={20}
            max={80}
            value={drawerSettings.customPanelWidth}
            integer
            onChange={(value) => updateDrawer({ customPanelWidth: value ?? 35 })}
          />
        </div>
      )}

      <h3 className={styles.sectionTitle} style={{ marginTop: 12 }}>Notifications</h3>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>TOAST POSITION</label>
        <div className={styles.segmented}>
          {([
            ['top-left', 'TL'],
            ['top', 'Top'],
            ['top-right', 'TR'],
            ['bottom-left', 'BL'],
            ['bottom', 'Bottom'],
            ['bottom-right', 'BR'],
          ] as const).map(([value, label]) => (
            <button
              key={value}
              type="button"
              className={clsx(styles.segmentedBtn, toastPosition === value && styles.segmentedBtnActive)}
              onClick={() => setSetting('toastPosition', value)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <h3 className={styles.sectionTitle} style={{ marginTop: 8 }}>Chat Heads</h3>

      <Toggle.Checkbox
        checked={chatHeadsEnabled}
        onChange={(checked) => setSetting('chatHeadsEnabled', checked)}
        label="Show chat heads"
        hint="Display floating indicators for background generations"
      />

      {chatHeadsEnabled && (
        <>
          <div className={styles.field}>
            <label className={styles.fieldLabel}>SIZE ({chatHeadsSize}px)</label>
            <div className={styles.rangeRow}>
              <input
                type="range"
                className={styles.rangeSlider}
                min={32}
                max={64}
                step={4}
                value={chatHeadsSize}
                onChange={(e) => setSetting('chatHeadsSize', parseInt(e.target.value, 10))}
              />
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>LAYOUT</label>
            <div className={styles.segmented}>
              {(['column', 'row'] as const).map((dir) => (
                <button
                  key={dir}
                  type="button"
                  className={`${styles.segmentedBtn} ${chatHeadsDirection === dir ? styles.segmentedBtnActive : ''}`}
                  onClick={() => setSetting('chatHeadsDirection', dir)}
                >
                  {dir === 'column' ? 'Vertical' : 'Horizontal'}
                </button>
              ))}
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>OPACITY ({Math.round(chatHeadsOpacity * 100)}%)</label>
            <div className={styles.rangeRow}>
              <input
                type="range"
                className={styles.rangeSlider}
                min={20}
                max={100}
                step={5}
                value={Math.round(chatHeadsOpacity * 100)}
                onChange={(e) => setSetting('chatHeadsOpacity', parseInt(e.target.value, 10) / 100)}
              />
            </div>
          </div>
        </>
      )}

      <h3 className={styles.sectionTitle} style={{ marginTop: 8 }}>Pagination</h3>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>LANDING PAGE LAYOUT</label>
        <div className={styles.segmented}>
          <button
            type="button"
            className={clsx(styles.segmentedBtn, landingPageLayoutMode === 'cards' && styles.segmentedBtnActive)}
            onClick={() => setSetting('landingPageLayoutMode', 'cards')}
          >
            Cards
          </button>
          <button
            type="button"
            className={clsx(styles.segmentedBtn, landingPageLayoutMode === 'compact' && styles.segmentedBtnActive)}
            onClick={() => setSetting('landingPageLayoutMode', 'compact')}
          >
            Compact List
          </button>
        </div>
        <p className={styles.helperText} style={{ marginTop: 8 }}>
          Switch the landing page between the current card gallery and a denser adaptive list of recent chats.
        </p>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>LANDING PAGE CHATS PER BATCH</label>
        <NumericInput
          className={styles.numberInput}
          min={4}
          max={100}
          value={landingPageChatsDisplayed}
          integer
          onChange={(value) => setSetting('landingPageChatsDisplayed', value ?? 12)}
        />
      </div>

    </div>
  )
}

function ChatSettings() {
  const displayMode = useStore((s) => s.chatSheldDisplayMode)
  const bubbleUserAlign = useStore((s) => s.bubbleUserAlign)
  const enterToSend = useStore((s) => s.chatSheldEnterToSend)
  const saveDraftInput = useStore((s) => s.saveDraftInput)
  const portraitPanelSide = useStore((s) => s.portraitPanelSide)
  const chatWidthMode = useStore((s) => s.chatWidthMode)
  const chatContentMaxWidth = useStore((s) => s.chatContentMaxWidth)
  const messagesPerPage = useStore((s) => s.messagesPerPage)
  const regenFeedback = useStore((s) => s.regenFeedback)
  const setSetting = useStore((s) => s.setSetting)
  const isMac = navigator.platform.toUpperCase().includes('MAC')

  return (
    <div className={styles.settingsSection}>
      <h3 className={styles.sectionTitle}>Chat</h3>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>Display mode</label>
        <div className={styles.displayModeGrid}>
          {/* ── Minimal card ── */}
          <button
            type="button"
            className={clsx(styles.displayModeCard, displayMode === 'minimal' && styles.displayModeCardActive)}
            onClick={() => setSetting('chatSheldDisplayMode', 'minimal')}
          >
            <div className={styles.previewMinimal}>
              {/* Character message */}
              <div className={styles.previewMinimalMsg}>
                <div className={styles.previewAccentLeft} />
                <div className={styles.previewMinimalAvatar} />
                <div className={styles.previewMinimalBody}>
                  <div className={styles.previewLine} style={{ width: '80%' }} />
                  <div className={styles.previewLine} style={{ width: '55%' }} />
                </div>
              </div>
              {/* User message */}
              <div className={clsx(styles.previewMinimalMsg, styles.previewMinimalMsgUser)}>
                <div className={styles.previewAccentRight} />
                <div className={styles.previewMinimalBody}>
                  <div className={styles.previewLine} style={{ width: '65%' }} />
                </div>
              </div>
              {/* Character message */}
              <div className={styles.previewMinimalMsg}>
                <div className={styles.previewAccentLeft} />
                <div className={styles.previewMinimalAvatar} />
                <div className={styles.previewMinimalBody}>
                  <div className={styles.previewLine} style={{ width: '90%' }} />
                  <div className={styles.previewLine} style={{ width: '40%' }} />
                </div>
              </div>
            </div>
            <span className={clsx(styles.displayModeLabel, displayMode === 'minimal' && styles.displayModeLabelActive)}>
              Minimal
            </span>
          </button>

          {/* ── Bubble card ── */}
          <button
            type="button"
            className={clsx(styles.displayModeCard, displayMode === 'bubble' && styles.displayModeCardActive)}
            onClick={() => setSetting('chatSheldDisplayMode', 'bubble')}
          >
            <div className={styles.previewBubble}>
              {/* Character bubble message */}
              <div className={styles.previewBubbleMsg}>
                <div className={styles.previewBubbleFade} />
                <div className={styles.previewBubbleHeader}>
                  <div className={styles.previewBubbleAvatar} />
                  <div className={styles.previewBubbleMeta}>
                    <div className={styles.previewBubbleName} />
                    <div className={styles.previewBubblePill} />
                  </div>
                </div>
                <div className={styles.previewBubbleContent}>
                  <div className={styles.previewLine} style={{ width: '90%' }} />
                  <div className={styles.previewLine} style={{ width: '70%' }} />
                  <div className={styles.previewLine} style={{ width: '50%' }} />
                </div>
              </div>
              {/* User bubble message */}
              <div className={clsx(styles.previewBubbleMsg, styles.previewBubbleMsgUser)}>
                <div className={clsx(styles.previewBubbleFade, styles.previewBubbleFadeUser)} />
                <div className={styles.previewBubbleContent}>
                  <div className={styles.previewLine} style={{ width: '75%' }} />
                  <div className={styles.previewLine} style={{ width: '55%' }} />
                </div>
              </div>
            </div>
            <span className={clsx(styles.displayModeLabel, displayMode === 'bubble' && styles.displayModeLabelActive)}>
              Bubble
            </span>
          </button>
        </div>
      </div>

      {displayMode === 'bubble' && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>User message alignment</label>
          <div className={styles.segmented}>
            {(['left', 'right'] as const).map((align) => (
              <button
                key={align}
                type="button"
                className={clsx(styles.segmentedBtn, (bubbleUserAlign ?? 'right') === align && styles.segmentedBtnActive)}
                onClick={() => setSetting('bubbleUserAlign', align)}
              >
                {align === 'left' ? 'Left' : 'Right'}
              </button>
            ))}
          </div>
        </div>
      )}

      <h3 className={styles.sectionTitle} style={{ marginTop: 12 }}>Chat Width</h3>
      <p className={styles.helperText}>
        Constrain the chat message area width. Useful for ultrawide monitors where full-width messages stretch too far.
      </p>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>CONTENT WIDTH</label>
        <div className={styles.segmented}>
          {(['full', 'comfortable', 'compact', 'custom'] as const).map((preset) => (
            <button
              key={preset}
              type="button"
              className={clsx(styles.segmentedBtn, chatWidthMode === preset && styles.segmentedBtnActive)}
              onClick={() => setSetting('chatWidthMode', preset)}
            >
              {preset === 'full' ? 'Full' : preset === 'comfortable' ? 'Comfortable' : preset === 'compact' ? 'Compact' : 'Custom'}
            </button>
          ))}
        </div>
      </div>

      {chatWidthMode === 'custom' && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>MAX WIDTH (px)</label>
          <div className={styles.rangeRow}>
            <input
              type="range"
              className={styles.rangeSlider}
              min={500}
              max={2000}
              step={10}
              value={chatContentMaxWidth}
              onChange={(e) => setSetting('chatContentMaxWidth', parseInt(e.target.value, 10))}
            />
            <span className={styles.rangeValue}>{chatContentMaxWidth}px</span>
          </div>
        </div>
      )}

      <h3 className={styles.sectionTitle} style={{ marginTop: 12 }}>Messages Per Page</h3>
      <p className={styles.helperText}>
        How many messages to load at a time. Lower values improve loading speed on slow connections.
      </p>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>MESSAGES PER PAGE</label>
        <div className={styles.segmented}>
          {[25, 50, 100, 200].map((value) => (
            <button
              key={value}
              type="button"
              className={clsx(styles.segmentedBtn, !![25, 50, 100, 200].includes(messagesPerPage ?? 50) && (messagesPerPage ?? 50) === value && styles.segmentedBtnActive)}
              onClick={() => setSetting('messagesPerPage', value)}
            >
              {value}
            </button>
          ))}
          <button
            type="button"
            className={clsx(styles.segmentedBtn, ![25, 50, 100, 200].includes(messagesPerPage ?? 50) && styles.segmentedBtnActive)}
            onClick={() => { if ([25, 50, 100, 200].includes(messagesPerPage ?? 50)) setSetting('messagesPerPage', 75) }}
          >
            Custom
          </button>
        </div>
      </div>

      {![25, 50, 100, 200].includes(messagesPerPage ?? 50) && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>CUSTOM VALUE</label>
          <div className={styles.rangeRow}>
            <input
              type="range"
              className={styles.rangeSlider}
              min={10}
              max={500}
              step={5}
              value={messagesPerPage ?? 50}
              onChange={(e) => setSetting('messagesPerPage', parseInt(e.target.value, 10))}
            />
            <span className={styles.rangeValue}>{messagesPerPage ?? 50}</span>
          </div>
        </div>
      )}

      <h3 className={styles.sectionTitle} style={{ marginTop: 12 }}>Input</h3>

      <Toggle.Checkbox
        checked={enterToSend}
        onChange={(checked) => setSetting('chatSheldEnterToSend', checked)}
        label="Press Enter to send"
        hint={enterToSend
          ? 'Use Shift+Enter for new line'
          : `Use ${isMac ? 'Cmd' : 'Ctrl'}+Enter to send`}
      />

      <Toggle.Checkbox
        checked={saveDraftInput}
        onChange={(checked) => setSetting('saveDraftInput', checked)}
        label="Save draft input"
        hint="Automatically saves your unsent message so it persists across page refreshes and chat switches"
      />

      <div className={styles.field}>
        <label className={styles.fieldLabel}>Portrait panel side</label>
        <select
          className={styles.select}
          value={portraitPanelSide}
          onChange={(e) => setSetting('portraitPanelSide', e.target.value as 'left' | 'right' | 'none')}
        >
          <option value="none">None</option>
          <option value="left">Left</option>
          <option value="right">Right</option>
        </select>
      </div>

      <h3 className={styles.sectionTitle} style={{ marginTop: 12 }}>Regeneration Feedback</h3>
      <p className={styles.helperText}>
        When enabled, a feedback prompt appears before each regeneration or swipe, letting you guide the next response.
      </p>

      <Toggle.Checkbox
        checked={regenFeedback.enabled}
        onChange={(checked) => setSetting('regenFeedback', { ...regenFeedback, enabled: checked })}
        label="Prompt for feedback on regenerate"
      />

      {regenFeedback.enabled && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Injection position</label>
          <div className={styles.segmented}>
            {([
              { value: 'user', label: 'User Message' },
              { value: 'system', label: 'System Prompt' },
            ] as const).map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={clsx(styles.segmentedBtn, regenFeedback.position === opt.value && styles.segmentedBtnActive)}
                onClick={() => setSetting('regenFeedback', { ...regenFeedback, position: opt.value })}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <p className={styles.helperText}>
            {regenFeedback.position === 'user'
              ? 'Feedback is appended to the last user message as [OOC: ...]'
              : 'Feedback is appended to the end of the system prompt as [OOC: ...]'}
          </p>
        </div>
      )}

      <h3 className={styles.sectionTitle} style={{ marginTop: 12 }}>Message Info</h3>

      <Toggle.Checkbox
        checked={useStore((s) => s.showMessageTokenCount ?? true)}
        onChange={(checked) => setSetting('showMessageTokenCount', checked)}
        label="Show token count in message pill"
        hint="Displays the token count for assistant messages in the timestamp badge below each message"
      />

      <h3 className={styles.sectionTitle} style={{ marginTop: 12 }}>Swipe Navigation</h3>
      <p className={styles.helperText}>
        Navigate message swipes using touch gestures (mobile) or arrow keys (desktop). Hold Shift and hover to target a specific message.
      </p>

      <Toggle.Checkbox
        checked={useStore((s) => s.swipeGesturesEnabled)}
        onChange={(checked) => setSetting('swipeGesturesEnabled', checked)}
        label="Enable swipe gestures & keyboard shortcuts"
      />
    </div>
  )
}

function ExtensionSettingsView() {
  const extensions = useStore((s) => s.extensions)
  const frontendCount = extensions.filter((ext) => ext.has_frontend).length

  return (
    <div className={styles.settingsSection}>
      <h3 className={styles.sectionTitle}>Extension Settings</h3>
      <p className={styles.placeholder}>
        Installed extensions can expose configuration controls here.
        {frontendCount > 0
          ? ` ${frontendCount} extension${frontendCount === 1 ? '' : 's'} can render frontend settings.`
          : ' No frontend-capable extensions are currently installed.'}
      </p>
    </div>
  )
}

function GuidedGenerationSettings() {
  const guides = useStore((s) => s.guidedGenerations)
  const setSetting = useStore((s) => s.setSetting)
  const [editingId, setEditingId] = useState<string | null>(null)

  const addGuide = () => {
    const next: GuidedGeneration = {
      id: createId('guide'),
      name: 'New Guide',
      content: '',
      position: 'system',
      mode: 'persistent',
      enabled: false,
      color: null,
    }
    setSetting('guidedGenerations', [...guides, next])
    setEditingId(next.id)
  }

  const updateGuide = (id: string, patch: Partial<GuidedGeneration>) => {
    setSetting('guidedGenerations', guides.map((g) => (g.id === id ? { ...g, ...patch } : g)))
  }

  const removeGuide = (id: string) => {
    setSetting('guidedGenerations', guides.filter((g) => g.id !== id))
    if (editingId === id) setEditingId(null)
  }

  return (
    <div className={styles.settingsSection}>
      <div className={styles.inlineHeader}>
        <h3 className={styles.sectionTitle}>Guided Generations</h3>
        <Button size="sm" onClick={addGuide}>New Guide</Button>
      </div>
      <p className={styles.placeholder}>Attach reusable prompts as system content or user prefixes/suffixes.</p>

      {guides.length === 0 && <p className={styles.placeholder}>No guides configured yet.</p>}

      {guides.map((g) => {
        const editing = editingId === g.id
        const positionLabel = { system: 'System', user_prefix: 'Before message', user_suffix: 'After message' }[g.position] ?? g.position
        const modeLabel = g.mode === 'oneshot' ? 'One-shot' : 'Persistent'
        return (
          <div key={g.id} className={clsx(styles.card, g.enabled && styles.cardEnabled)}>
            <div className={styles.cardRow}>
              <Toggle.Switch checked={g.enabled} onChange={(v) => updateGuide(g.id, { enabled: v })} size="sm" />
              <div className={styles.cardTitleWrap}>
                <div className={styles.cardTitle}>{g.name || 'Untitled Guide'}</div>
                <div className={styles.cardMeta}>{modeLabel} · {positionLabel}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditingId(editing ? null : g.id)}>{editing ? 'Done' : 'Edit'}</Button>
              <Button variant="danger-ghost" size="sm" onClick={() => removeGuide(g.id)}>Delete</Button>
            </div>

            {editing && (
              <div className={styles.editorGrid}>
                <input
                  className={styles.select}
                  value={g.name}
                  onChange={(e) => updateGuide(g.id, { name: e.target.value })}
                  placeholder="Guide name"
                />
                <div className={styles.drawerRow}>
                  <select className={styles.select} value={g.position} onChange={(e) => updateGuide(g.id, { position: e.target.value as GuidedGeneration['position'] })}>
                    <option value="system">System</option>
                    <option value="user_prefix">Before message</option>
                    <option value="user_suffix">After message</option>
                  </select>
                  <select className={styles.select} value={g.mode} onChange={(e) => updateGuide(g.id, { mode: e.target.value as GuidedGeneration['mode'] })}>
                    <option value="persistent">Persistent</option>
                    <option value="oneshot">One-shot</option>
                  </select>
                </div>
                <textarea
                  className={styles.textarea}
                  value={g.content}
                  onChange={(e) => updateGuide(g.id, { content: e.target.value })}
                  placeholder="Guide prompt content"
                  rows={4}
                />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function QuickRepliesSettings() {
  const sets = useStore((s) => s.quickReplySets)
  const setSetting = useStore((s) => s.setSetting)
  const [editingSetId, setEditingSetId] = useState<string | null>(null)

  const addSet = () => {
    const next: QuickReplySet = {
      id: createId('qrs'),
      name: 'New Set',
      color: null,
      enabled: true,
      replies: [],
    }
    setSetting('quickReplySets', [...sets, next])
    setEditingSetId(next.id)
  }

  const updateSet = (id: string, patch: Partial<QuickReplySet>) => {
    setSetting('quickReplySets', sets.map((s) => (s.id === id ? { ...s, ...patch } : s)))
  }

  const removeSet = (id: string) => {
    setSetting('quickReplySets', sets.filter((s) => s.id !== id))
    if (editingSetId === id) setEditingSetId(null)
  }

  const addReply = (setId: string) => {
    setSetting('quickReplySets', sets.map((s) => {
      if (s.id !== setId) return s
      return {
        ...s,
        replies: [...s.replies, { id: createId('qr'), label: 'New Reply', message: '' }],
      }
    }))
  }

  const updateReply = (setId: string, replyId: string, patch: { label?: string; message?: string }) => {
    setSetting('quickReplySets', sets.map((s) => {
      if (s.id !== setId) return s
      return {
        ...s,
        replies: s.replies.map((r) => (r.id === replyId ? { ...r, ...patch } : r)),
      }
    }))
  }

  const removeReply = (setId: string, replyId: string) => {
    setSetting('quickReplySets', sets.map((s) => {
      if (s.id !== setId) return s
      return {
        ...s,
        replies: s.replies.filter((r) => r.id !== replyId),
      }
    }))
  }

  return (
    <div className={styles.settingsSection}>
      <div className={styles.inlineHeader}>
        <h3 className={styles.sectionTitle}>Quick Replies</h3>
        <Button size="sm" onClick={addSet}>New Set</Button>
      </div>
      <p className={styles.placeholder}>Build your own quick-reply sets for the input bar popover.</p>

      {sets.length === 0 && <p className={styles.placeholder}>No quick reply sets configured yet.</p>}

      {sets.map((set) => {
        const editing = editingSetId === set.id
        return (
          <div key={set.id} className={clsx(styles.card, set.enabled && styles.cardEnabled)}>
            <div className={styles.cardRow}>
              <Toggle.Switch checked={set.enabled} onChange={(v) => updateSet(set.id, { enabled: v })} size="sm" />
              <div className={styles.cardTitleWrap}>
                <div className={styles.cardTitle}>{set.name || 'Untitled Set'}</div>
                <div className={styles.cardMeta}>{set.replies.length} {set.replies.length === 1 ? 'reply' : 'replies'}</div>
              </div>
              <Button variant="ghost" size="sm" onClick={() => setEditingSetId(editing ? null : set.id)}>{editing ? 'Done' : 'Edit'}</Button>
              <Button variant="danger-ghost" size="sm" onClick={() => removeSet(set.id)}>Delete</Button>
            </div>

            {editing && (
              <div className={styles.editorGrid}>
                <input
                  className={styles.select}
                  value={set.name}
                  onChange={(e) => updateSet(set.id, { name: e.target.value })}
                  placeholder="Set name"
                />

                {set.replies.map((reply) => (
                  <div key={reply.id} className={styles.quickReplyEditor}>
                    <input
                      className={styles.select}
                      value={reply.label}
                      onChange={(e) => updateReply(set.id, reply.id, { label: e.target.value })}
                      placeholder="Label"
                    />
                    <textarea
                      className={styles.textarea}
                      value={reply.message}
                      onChange={(e) => updateReply(set.id, reply.id, { message: e.target.value })}
                      placeholder="Message"
                      rows={2}
                    />
                    <Button variant="danger-ghost" size="sm" onClick={() => removeReply(set.id, reply.id)}>Remove</Button>
                  </div>
                ))}

                <Button size="sm" onClick={() => addReply(set.id)}>Add Reply</Button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let next = value
  let unit = units[0]
  for (const candidate of units) {
    unit = candidate
    next /= 1024
    if (next < 1024) break
  }
  return `${next.toFixed(next >= 100 ? 0 : 1)} ${unit}`
}

type PoolEditUnit = 'bytes' | 'mb' | 'gb'

function unitDivisor(unit: PoolEditUnit): number {
  if (unit === 'gb') return 1024 * 1024 * 1024
  if (unit === 'mb') return 1024 * 1024
  return 1
}

function convertUnitValue(value: string, from: PoolEditUnit, to: PoolEditUnit): string {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return ''
  const bytes = n * unitDivisor(from)
  const converted = bytes / unitDivisor(to)
  return String(Math.max(1, Math.round(converted)))
}

function parseValueToBytes(value: string, unit: PoolEditUnit): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return NaN
  return Math.floor(n * unitDivisor(unit))
}

function parseOverridesDetailed(text: string, unit: PoolEditUnit): {
  values: Record<string, number>
  invalidLines: Array<{ line: number; content: string; reason: string }>
} {
  const out: Record<string, number> = {}
  const invalidLines: Array<{ line: number; content: string; reason: string }> = []

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const trimmed = line.trim()
    if (!trimmed) continue
    const [identifier, raw] = trimmed.includes('=')
      ? trimmed.split('=').map((s) => s.trim())
      : trimmed.split(':').map((s) => s.trim())
    if (!identifier || !raw) {
      invalidLines.push({ line: i + 1, content: trimmed, reason: 'expected identifier=value' })
      continue
    }
    if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
      invalidLines.push({ line: i + 1, content: trimmed, reason: 'invalid identifier format' })
      continue
    }
    const match = raw.match(/^(\d+(?:\.\d+)?)\s*(b|mb|gb)?$/i)
    if (!match) {
      invalidLines.push({ line: i + 1, content: trimmed, reason: 'invalid numeric/unit value' })
      continue
    }
    const numeric = Number(match[1])
    if (!Number.isFinite(numeric) || numeric <= 0) {
      invalidLines.push({ line: i + 1, content: trimmed, reason: 'value must be positive' })
      continue
    }
    const explicitUnit = (match[2] || '').toLowerCase() as '' | 'b' | 'mb' | 'gb'
    const resolvedUnit: PoolEditUnit = explicitUnit === 'gb'
      ? 'gb'
      : explicitUnit === 'mb'
        ? 'mb'
        : explicitUnit === 'b'
          ? 'bytes'
          : unit
    out[identifier] = Math.floor(numeric * unitDivisor(resolvedUnit))
  }

  return { values: out, invalidLines }
}

function parseOverrides(text: string, unit: PoolEditUnit): Record<string, number> {
  return parseOverridesDetailed(text, unit).values
}

function ExtensionPoolSettings() {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [refreshing, setRefreshing] = useState(false)

  const [overviewMe, setOverviewMe] = useState<Awaited<ReturnType<typeof spindleApi.getEphemeralOverviewMe>> | null>(null)
  const [overviewAdmin, setOverviewAdmin] = useState<Awaited<ReturnType<typeof spindleApi.getEphemeralOverviewAdmin>> | null>(null)

  const [globalMaxBytes, setGlobalMaxBytes] = useState('')
  const [extensionDefaultMaxBytes, setExtensionDefaultMaxBytes] = useState('')
  const [reservationTtlMs, setReservationTtlMs] = useState('')
  const [overrideText, setOverrideText] = useState('')
  const [poolUnit, setPoolUnit] = useState<PoolEditUnit>('mb')
  const [password, setPassword] = useState('')
  const [saveMessage, setSaveMessage] = useState<string | null>(null)
  const [focusedInvalidLine, setFocusedInvalidLine] = useState<number | null>(null)
  const overridesRef = useRef<HTMLTextAreaElement | null>(null)

  const canEditPools = !!overviewMe?.canEditPools

  const load = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true)
    else setLoading(true)
    setError(null)
    try {
      const me = await spindleApi.getEphemeralOverviewMe()
      setOverviewMe(me)

      if (me.canEditPools) {
        const [admin, cfg] = await Promise.all([
          spindleApi.getEphemeralOverviewAdmin(),
          spindleApi.getEphemeralConfig(),
        ])
        setOverviewAdmin(admin)
        setGlobalMaxBytes(String(Math.round(cfg.globalMaxBytes / unitDivisor(poolUnit))))
        setExtensionDefaultMaxBytes(String(Math.round(cfg.extensionDefaultMaxBytes / unitDivisor(poolUnit))))
        setReservationTtlMs(String(cfg.reservationTtlMs))
        setOverrideText(
          Object.entries(cfg.extensionMaxOverrides)
            .map(([id, bytes]) => `${id}=${Math.round(bytes / unitDivisor(poolUnit))}`)
            .join('\n')
        )
      } else {
        setOverviewAdmin(null)
      }
    } catch (err: any) {
      const msg = err?.body?.error || err?.message || 'Failed to load pool settings'
      setError(msg)
    } finally {
      if (isRefresh) setRefreshing(false)
      else setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const rows = useMemo(() => {
    if (overviewAdmin) return overviewAdmin.extensions
    return overviewMe?.extensions || []
  }, [overviewAdmin, overviewMe])

  const overrideValidation = useMemo(
    () => parseOverridesDetailed(overrideText, poolUnit),
    [overrideText, poolUnit]
  )

  const globalBytesValue = parseValueToBytes(globalMaxBytes, poolUnit)
  const extensionDefaultBytesValue = parseValueToBytes(extensionDefaultMaxBytes, poolUnit)
  const hasPoolThresholdWarning =
    Number.isFinite(globalBytesValue) &&
    Number.isFinite(extensionDefaultBytesValue) &&
    extensionDefaultBytesValue > globalBytesValue

  const approxFullDefaultExtensions =
    Number.isFinite(globalBytesValue) && Number.isFinite(extensionDefaultBytesValue) && extensionDefaultBytesValue > 0
      ? Math.max(0, Math.floor(globalBytesValue / extensionDefaultBytesValue))
      : 0

  const handleSave = async () => {
    setSaveMessage(null)
    setError(null)
    const global = parseValueToBytes(globalMaxBytes, poolUnit)
    const extDefault = parseValueToBytes(extensionDefaultMaxBytes, poolUnit)
    const ttl = Number(reservationTtlMs)

    if (!Number.isFinite(global) || global <= 0) {
      setError('Global max bytes must be a positive number')
      return
    }
    if (!Number.isFinite(extDefault) || extDefault <= 0) {
      setError('Per-extension default max bytes must be a positive number')
      return
    }
    if (!Number.isFinite(ttl) || ttl <= 0) {
      setError('Reservation TTL must be a positive number')
      return
    }

    if (!password.trim()) {
      setError('Owner password is required to save pool changes')
      return
    }

    setSaving(true)
    try {
      await spindleApi.setEphemeralConfig({
        password: password.trim(),
        globalMaxBytes: Math.floor(global),
        extensionDefaultMaxBytes: Math.floor(extDefault),
        reservationTtlMs: Math.floor(ttl),
        extensionMaxOverrides: parseOverrides(overrideText, poolUnit),
      })
      setSaveMessage('Pool configuration updated')
      setPassword('')
      await load(true)
    } catch (err: any) {
      const msg = err?.body?.error || err?.message || 'Failed to save pool settings'
      setError(msg)
    } finally {
      setSaving(false)
    }
  }

  const global = overviewAdmin?.global || overviewMe?.global

  const focusInvalidOverrideLine = (lineNumber: number) => {
    const ta = overridesRef.current
    if (!ta) return
    const lines = ta.value.split('\n')
    const clamped = Math.max(1, Math.min(lineNumber, lines.length))
    let start = 0
    for (let i = 0; i < clamped - 1; i += 1) {
      start += lines[i].length + 1
    }
    const end = start + (lines[clamped - 1]?.length || 0)
    ta.focus()
    ta.setSelectionRange(start, end)

    const total = lines.length || 1
    const ratio = (clamped - 1) / Math.max(1, total - 1)
    const target = ratio * Math.max(0, ta.scrollHeight - ta.clientHeight)
    ta.scrollTop = target

    setFocusedInvalidLine(clamped)
    window.setTimeout(() => setFocusedInvalidLine((prev) => (prev === clamped ? null : prev)), 1200)
  }

  const changePoolUnit = (nextUnit: PoolEditUnit) => {
    if (nextUnit === poolUnit) return
    setGlobalMaxBytes((v) => convertUnitValue(v, poolUnit, nextUnit))
    setExtensionDefaultMaxBytes((v) => convertUnitValue(v, poolUnit, nextUnit))
    setOverrideText((text) => {
      const parsed = parseOverrides(text, poolUnit)
      return Object.entries(parsed)
        .map(([id, bytes]) => `${id}=${Math.max(1, Math.round(bytes / unitDivisor(nextUnit)))}`)
        .join('\n')
    })
    setPoolUnit(nextUnit)
  }

  return (
    <div className={styles.settingsSection}>
      <div className={styles.inlineHeader}>
        <h3 className={styles.sectionTitle}>Extension Ephemeral Pools</h3>
        <Button
          size="icon"
          onClick={() => load(true)}
          disabled={refreshing || loading}
          title="Refresh pool data"
          aria-label="Refresh pool data"
          icon={<RefreshCw size={13} className={refreshing ? spinClass : undefined} />}
        />
      </div>

      {loading ? (
        <p className={styles.placeholder}>Loading extension pool metrics...</p>
      ) : (
        <>
          {error && <p className={styles.errorText}>{error}</p>}
          {saveMessage && <p className={styles.successText}>{saveMessage}</p>}

          {global && (
            <div className={styles.poolSummaryGrid}>
              <div className={styles.poolSummaryCard}>
                <span className={styles.fieldLabel}>GLOBAL USED</span>
                <strong>{formatBytes(global.usedBytes)}</strong>
              </div>
              <div className={styles.poolSummaryCard}>
                <span className={styles.fieldLabel}>GLOBAL RESERVED</span>
                <strong>{formatBytes(global.reservedBytes)}</strong>
              </div>
              <div className={styles.poolSummaryCard}>
                <span className={styles.fieldLabel}>GLOBAL AVAILABLE</span>
                <strong>{formatBytes(global.availableBytes)}</strong>
              </div>
            </div>
          )}

          <div className={styles.poolList}>
            {rows.map((row) => {
              const usedPct = row.extensionMaxBytes > 0
                ? Math.min(100, ((row.usedBytes + row.reservedBytes) / row.extensionMaxBytes) * 100)
                : 0

              return (
                <div key={row.extensionId} className={styles.poolRow}>
                  <div className={styles.poolRowTop}>
                    <div>
                      <div className={styles.cardTitle}>{row.name} <span className={styles.poolIdentifier}>({row.identifier})</span></div>
                      <div className={styles.cardMeta}>
                        {row.enabled ? 'Enabled' : 'Disabled'} • {row.hasEphemeralPermission ? 'ephemeral permission granted' : 'no ephemeral permission'}
                      </div>
                    </div>
                    <div className={styles.poolNumbers}>
                      {formatBytes(row.usedBytes)} used + {formatBytes(row.reservedBytes)} reserved / {formatBytes(row.extensionMaxBytes)}
                    </div>
                  </div>
                  <div className={styles.poolBar}>
                    <div className={styles.poolBarFill} style={{ width: `${usedPct}%` }} />
                  </div>
                  <div className={styles.cardMeta}>Files: {row.fileCount} • Available: {formatBytes(row.availableBytes)}</div>
                </div>
              )
            })}
          </div>

          {canEditPools && (
            <div className={styles.adminPoolSection}>
              <h4 className={styles.subsectionTitle}>Pool Configuration</h4>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>EDIT SIZE UNIT</label>
                <div className={styles.segmented}>
                  <button type="button" className={clsx(styles.segmentedBtn, poolUnit === 'bytes' && styles.segmentedBtnActive)} onClick={() => changePoolUnit('bytes')}>Bytes</button>
                  <button type="button" className={clsx(styles.segmentedBtn, poolUnit === 'mb' && styles.segmentedBtnActive)} onClick={() => changePoolUnit('mb')}>MB</button>
                  <button type="button" className={clsx(styles.segmentedBtn, poolUnit === 'gb' && styles.segmentedBtnActive)} onClick={() => changePoolUnit('gb')}>GB</button>
                </div>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>GLOBAL MAX ({poolUnit.toUpperCase()})</label>
                <input className={styles.numberInput} type="number" min={1} value={globalMaxBytes} onChange={(e) => setGlobalMaxBytes(e.target.value)} />
                <div className={styles.helperText}>
                  {Number.isFinite(globalBytesValue)
                    ? `${globalBytesValue.toLocaleString()} bytes`
                    : 'Enter a positive number'}
                </div>
                {Number.isFinite(globalBytesValue) && Number.isFinite(extensionDefaultBytesValue) && extensionDefaultBytesValue > 0 && (
                  <div className={styles.helperText}>
                    Fits roughly {approxFullDefaultExtensions} extension(s) at the default cap.
                  </div>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>PER-EXTENSION DEFAULT MAX ({poolUnit.toUpperCase()})</label>
                <input className={styles.numberInput} type="number" min={1} value={extensionDefaultMaxBytes} onChange={(e) => setExtensionDefaultMaxBytes(e.target.value)} />
                <div className={styles.helperText}>
                  {Number.isFinite(extensionDefaultBytesValue)
                    ? `${extensionDefaultBytesValue.toLocaleString()} bytes`
                    : 'Enter a positive number'}
                </div>
                {hasPoolThresholdWarning && (
                  <div className={styles.warningText}>
                    Warning: per-extension default exceeds global cap.
                  </div>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>RESERVATION TTL (MS)</label>
                <input className={styles.numberInput} type="number" min={1} value={reservationTtlMs} onChange={(e) => setReservationTtlMs(e.target.value)} />
                <div className={styles.helperText}>
                  {Number.isFinite(Number(reservationTtlMs)) && Number(reservationTtlMs) > 0
                    ? `${Math.round(Number(reservationTtlMs) / 1000)} seconds`
                    : 'Enter a positive number'}
                </div>
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>PER-EXTENSION OVERRIDES (identifier=value per line, optional suffix b/mb/gb)</label>
                <textarea
                  ref={overridesRef}
                  className={styles.textarea}
                  rows={5}
                  value={overrideText}
                  onChange={(e) => setOverrideText(e.target.value)}
                  placeholder={`simtracker=${poolUnit === 'gb' ? '1' : poolUnit === 'mb' ? '100' : '104857600'}`}
                />
                {overrideValidation.invalidLines.length > 0 && (
                  <div className={styles.warningText}>
                    Invalid override lines:{' '}
                    {overrideValidation.invalidLines.map((x, idx) => (
                      <span key={`${x.line}-${x.reason}`}>
                        {idx > 0 ? ', ' : ''}
                        <button
                          type="button"
                          className={styles.inlineLinkBtn}
                          onClick={() => focusInvalidOverrideLine(x.line)}
                        >
                          {x.line}
                        </button>
                        <span> ({x.reason})</span>
                      </span>
                    ))}
                  </div>
                )}
                {focusedInvalidLine !== null && (
                  <div className={styles.helperText}>Focused line {focusedInvalidLine} in overrides editor.</div>
                )}
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>OWNER PASSWORD (required to save)</label>
                <input
                  className={styles.select}
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter owner password"
                />
              </div>
              <Button size="sm" onClick={handleSave} disabled={saving} loading={saving}>
                {saving ? 'Saving...' : 'Save Pool Config'}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function EmbeddingsSettings() {
  const WORLD_BOOK_VECTOR_PRESETS: Record<Exclude<WorldBookVectorPresetMode, 'custom'>, Omit<WorldBookVectorSettings, 'presetMode'>> = {
    lean: {
      chunkTargetTokens: 220,
      chunkMaxTokens: 360,
      chunkOverlapTokens: 40,
      retrievalTopK: 4,
      maxChunksPerEntry: 4,
    },
    balanced: {
      chunkTargetTokens: 420,
      chunkMaxTokens: 700,
      chunkOverlapTokens: 80,
      retrievalTopK: 6,
      maxChunksPerEntry: 8,
    },
    deep: {
      chunkTargetTokens: 720,
      chunkMaxTokens: 1200,
      chunkOverlapTokens: 120,
      retrievalTopK: 8,
      maxChunksPerEntry: 12,
    },
  }
  const DEFAULT_WORLD_BOOK_VECTOR_SETTINGS: WorldBookVectorSettings = {
    presetMode: 'balanced',
    ...WORLD_BOOK_VECTOR_PRESETS.balanced,
  }

  const normalizeWorldBookVectorSettings = (
    value: unknown,
    retrievalFallback: number,
  ): WorldBookVectorSettings => {
    const raw = (value && typeof value === 'object') ? value as Partial<WorldBookVectorSettings> : {}
    const base = {
      ...DEFAULT_WORLD_BOOK_VECTOR_SETTINGS,
      retrievalTopK: retrievalFallback,
    }
    const presetMode: WorldBookVectorPresetMode = raw.presetMode === 'lean' || raw.presetMode === 'balanced' || raw.presetMode === 'deep' || raw.presetMode === 'custom'
      ? raw.presetMode
      : base.presetMode
    const preset = presetMode === 'custom' ? null : WORLD_BOOK_VECTOR_PRESETS[presetMode]
    const target = Math.min(2000, Math.max(120, Math.floor((preset?.chunkTargetTokens ?? raw.chunkTargetTokens ?? base.chunkTargetTokens))))
    const max = Math.min(4000, Math.max(target, Math.floor((preset?.chunkMaxTokens ?? raw.chunkMaxTokens ?? base.chunkMaxTokens))))
    return {
      presetMode,
      chunkTargetTokens: target,
      chunkMaxTokens: max,
      chunkOverlapTokens: Math.min(500, Math.max(0, Math.floor((preset?.chunkOverlapTokens ?? raw.chunkOverlapTokens ?? base.chunkOverlapTokens)))),
      retrievalTopK: Math.min(20, Math.max(1, Math.floor((preset?.retrievalTopK ?? raw.retrievalTopK ?? base.retrievalTopK)))),
      maxChunksPerEntry: Math.min(24, Math.max(1, Math.floor((preset?.maxChunksPerEntry ?? raw.maxChunksPerEntry ?? base.maxChunksPerEntry)))),
    }
  }

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [cfg, setCfg] = useState<EmbeddingConfig | null>(null)
  const [worldBookSettings, setWorldBookSettings] = useState<WorldBookVectorSettings>(DEFAULT_WORLD_BOOK_VECTOR_SETTINGS)
  const [worldBookSettingsLoading, setWorldBookSettingsLoading] = useState(true)
  const [worldBookSettingsStatus, setWorldBookSettingsStatus] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [modelLabels, setModelLabels] = useState<Record<string, string>>({})
  const [modelsLoading, setModelsLoading] = useState(false)
  const worldBookSettingsLoadedRef = useRef(false)
  const worldBookSettingsDirtyRef = useRef(false)
  const worldBookSettingsSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await embeddingsApi.getConfig()
      setCfg(next)
      setApiKey('')
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Failed to load embedding settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  useEffect(() => {
    let cancelled = false
    setWorldBookSettingsLoading(true)
    settingsApi.get('worldBookVectorSettings')
      .then((row) => {
        if (cancelled) return
        setWorldBookSettings(normalizeWorldBookVectorSettings(row.value, cfg?.retrieval_top_k ?? DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.retrievalTopK))
        worldBookSettingsLoadedRef.current = true
      })
      .catch(() => {
        if (cancelled) return
        setWorldBookSettings(normalizeWorldBookVectorSettings(null, cfg?.retrieval_top_k ?? DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.retrievalTopK))
        worldBookSettingsLoadedRef.current = true
      })
      .finally(() => {
        if (!cancelled) setWorldBookSettingsLoading(false)
      })
    return () => { cancelled = true }
  }, [cfg?.retrieval_top_k])

  useEffect(() => () => {
    if (worldBookSettingsSaveTimerRef.current) clearTimeout(worldBookSettingsSaveTimerRef.current)
  }, [])

  useEffect(() => {
    if (!worldBookSettingsLoadedRef.current || !worldBookSettingsDirtyRef.current) return
    if (worldBookSettingsSaveTimerRef.current) clearTimeout(worldBookSettingsSaveTimerRef.current)
    setWorldBookSettingsStatus('Saving world-book settings...')
    worldBookSettingsSaveTimerRef.current = setTimeout(async () => {
      try {
        await settingsApi.put('worldBookVectorSettings', worldBookSettings)
        worldBookSettingsDirtyRef.current = false
        setWorldBookSettingsStatus('World-book settings saved')
      } catch (err: any) {
        setWorldBookSettingsStatus(err?.body?.error || err?.message || 'Failed to save world-book settings')
      }
    }, 400)
    return () => {
      if (worldBookSettingsSaveTimerRef.current) clearTimeout(worldBookSettingsSaveTimerRef.current)
    }
  }, [worldBookSettings])

  useEffect(() => {
    setModels([])
    setModelLabels({})
  }, [cfg?.provider, cfg?.api_url])

  const PROVIDER_DEFAULTS: Record<string, { api_url: string }> = {
    'openai-compatible': { api_url: 'https://api.openai.com/v1/embeddings' },
    openai: { api_url: 'https://api.openai.com/v1/embeddings' },
    openrouter: { api_url: 'https://openrouter.ai/api/v1/embeddings' },
    electronhub: { api_url: 'https://api.electronhub.top/v1/embeddings' },
    bananabread: { api_url: 'http://localhost:8008/v1/embeddings' },
    nanogpt: { api_url: 'https://nano-gpt.com/api/v1/embeddings' },
  }

  const providerAllowsCustomApiUrl = (provider: EmbeddingConfig['provider']) => {
    return provider === 'openai-compatible' || provider === 'bananabread'
  }

  const update = (patch: Partial<EmbeddingConfig>) => {
    setCfg((current) => {
      if (!current) return current
      let nextPatch = patch
      // When provider changes, auto-fill URL with provider default.
      if (nextPatch.provider && nextPatch.provider !== current.provider) {
        const defaults = PROVIDER_DEFAULTS[nextPatch.provider]
        if (defaults) {
          nextPatch = { ...nextPatch, api_url: defaults.api_url }
        }
      }
      return { ...current, ...nextPatch }
    })
  }

  const updateWorldBookSettings = (patch: Partial<WorldBookVectorSettings>) => {
    worldBookSettingsDirtyRef.current = true
    setWorldBookSettings((current) => normalizeWorldBookVectorSettings({ ...current, ...patch }, cfg?.retrieval_top_k ?? DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.retrievalTopK))
  }

  const applyWorldBookPreset = (presetMode: WorldBookVectorPresetMode) => {
    worldBookSettingsDirtyRef.current = true
    setWorldBookSettings((current) => normalizeWorldBookVectorSettings({ ...current, presetMode }, cfg?.retrieval_top_k ?? DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.retrievalTopK))
  }

  const save = async () => {
    if (!cfg) return
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const saved = await embeddingsApi.updateConfig({
        enabled: cfg.enabled,
        provider: cfg.provider,
        api_url: cfg.api_url,
        model: cfg.model,
        dimensions: cfg.dimensions,
        retrieval_top_k: worldBookSettings.retrievalTopK,
        hybrid_weight_mode: cfg.hybrid_weight_mode,
        preferred_context_size: cfg.preferred_context_size,
        batch_size: cfg.batch_size,
        similarity_threshold: cfg.similarity_threshold,
        rerank_cutoff: cfg.rerank_cutoff,
        vectorize_world_books: cfg.vectorize_world_books,
        vectorize_chat_messages: cfg.vectorize_chat_messages,
        vectorize_chat_documents: cfg.vectorize_chat_documents,
        chat_memory_mode: cfg.chat_memory_mode,
        request_timeout: cfg.request_timeout,
        api_key: apiKey.trim() ? apiKey.trim() : undefined,
      })
      setCfg(saved)
      setApiKey('')
      setSuccess('Embedding settings saved')
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Failed to save embedding settings')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError(null)
    setSuccess(null)
    try {
      const result = await embeddingsApi.testConfig('Lumiverse vector test')
      setCfg((current) => current
        ? {
            ...current,
            dimensions: result.applied_dimensions,
            has_api_key: result.config.has_api_key,
            inherited: result.config.inherited,
          }
        : result.config)
      setSuccess(`Embedding test passed. Dimensions set to ${result.applied_dimensions}.`)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Embedding test failed')
    } finally {
      setTesting(false)
    }
  }

  const fetchModels = async () => {
    if (!cfg) return
    setModelsLoading(true)
    try {
      const result = await embeddingsApi.previewModels({
        provider: cfg.provider,
        api_url: cfg.api_url || undefined,
        api_key: apiKey.trim() || undefined,
      })
      setModels(result.models || [])
      setModelLabels(result.model_labels || {})
    } catch {
      setModels([])
      setModelLabels({})
    } finally {
      setModelsLoading(false)
    }
  }

  if (loading || !cfg) {
    return (
      <div className={styles.settingsSection}>
        <h3 className={styles.sectionTitle}>Embeddings</h3>
        <p className={styles.placeholder}>Loading embedding settings...</p>
      </div>
    )
  }

  const setupChecklist = [
    {
      label: 'Embeddings enabled',
      description: 'Turns on vector features across Lumiverse.',
      complete: cfg.enabled,
    },
    {
      label: 'API key configured',
      description: 'Lets the app reach your embedding provider.',
      complete: cfg.has_api_key,
    },
    {
      label: 'Embedding dimensions detected',
      description: 'Run a test once so Lumiverse knows the vector size.',
      complete: !!cfg.dimensions,
    },
    {
      label: 'World-book vectorization enabled',
      description: 'Allows lorebook entries to be indexed and searched with vectors.',
      complete: cfg.vectorize_world_books,
    },
  ]
  const completedChecklistCount = setupChecklist.filter((item) => item.complete).length
  const checklistPercent = Math.round((completedChecklistCount / setupChecklist.length) * 100)
  const checklistReady = completedChecklistCount === setupChecklist.length

  const inherited = !!cfg.inherited
  const canEditApiUrl = providerAllowsCustomApiUrl(cfg.provider)
  const defaultApiUrl = PROVIDER_DEFAULTS[cfg.provider]?.api_url || cfg.api_url
  const worldBookPresetDescriptions: Record<WorldBookVectorPresetMode, string> = {
    lean: 'Smaller chunks and lighter storage for compact lorebooks.',
    balanced: 'Recommended. Better coverage without blowing up index size.',
    deep: 'More chunks and broader recall for dense reference books.',
    custom: 'Tune chunking, recall, and storage manually.',
  }

  return (
    <div className={styles.settingsSection}>
      <h3 className={styles.sectionTitle}>Embeddings</h3>
      <p className={styles.placeholder}>Configure vector embeddings for long-term memory retrieval. Vectorizes world books, chat messages, and documents for vector search during generation.</p>

      {inherited && (
        <p className={styles.placeholder} style={{ fontStyle: 'normal', padding: '8px 12px', border: '1px solid var(--lumiverse-border-subtle)', borderRadius: 6, background: 'var(--lumiverse-surface-raised)' }}>
          These embedding settings are managed by the server owner. Your account inherits the shared configuration and uses the owner's API key — you cannot change the provider, model, or key here. Test verifies the inherited connection works for your account.
        </p>
      )}

      {error && <p className={styles.errorText}>{error}</p>}
      {success && <p className={styles.successText}>{success}</p>}

      <div className={styles.embeddingChecklist}>
        <div className={styles.embeddingChecklistHeader}>
          <div className={styles.embeddingChecklistHeaderCopy}>
            <div className={styles.embeddingChecklistEyebrow}>Readiness</div>
            <div className={styles.embeddingChecklistTitle}>Embedding setup</div>
            <div className={styles.embeddingChecklistSubtitle}>
              {checklistReady
                ? 'Vector search is ready for world books.'
                : `${completedChecklistCount} of ${setupChecklist.length} setup steps complete.`}
            </div>
          </div>
          <div className={styles.embeddingChecklistScore}>
            <span className={styles.embeddingChecklistScoreValue}>
              {completedChecklistCount}/{setupChecklist.length}
            </span>
            <span className={styles.embeddingChecklistScoreLabel}>
              {checklistReady ? 'Ready' : 'In progress'}
            </span>
          </div>
        </div>
        <div className={styles.embeddingChecklistProgress}>
          <span
            className={styles.embeddingChecklistProgressFill}
            style={{ width: `${checklistPercent}%` }}
          />
        </div>
        <div className={styles.embeddingChecklistItems}>
          {setupChecklist.map((item, index) => (
            <div
              key={item.label}
              className={clsx(
                styles.embeddingChecklistItem,
                item.complete && styles.embeddingChecklistItemComplete,
              )}
            >
              <span className={styles.embeddingChecklistStep}>
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className={styles.embeddingChecklistItemBody}>
                <div className={styles.embeddingChecklistItemTop}>
                  <span className={styles.embeddingChecklistItemLabel}>{item.label}</span>
                  <span className={item.complete ? styles.embeddingChecklistDone : styles.embeddingChecklistTodo}>
                    {item.complete ? 'Ready' : 'Needs attention'}
                  </span>
                </div>
                <span className={styles.embeddingChecklistItemDescription}>
                  {item.description}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className={styles.settingsCard}>
        <div className={styles.settingsCardHeader}>
          <div>
            <div className={styles.subsectionTitle}>Connection</div>
            <div className={styles.settingsCardTitle}>Provider and model</div>
          </div>
        </div>
        <div className={styles.settingsCardBody}>
          <Toggle.Checkbox
            checked={cfg.enabled}
            onChange={(checked) => update({ enabled: checked })}
            label="Enable embeddings"
          />

          <div className={styles.settingsGridTwo}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Provider</label>
              <select className={styles.select} value={cfg.provider} onChange={(e) => update({ provider: e.target.value as EmbeddingConfig['provider'] })} disabled={inherited}>
                <option value="openai-compatible">OpenAI Compatible</option>
                <option value="openai">OpenAI</option>
                <option value="openrouter">OpenRouter</option>
                <option value="electronhub">ElectronHub</option>
                <option value="bananabread">BananaBread</option>
                <option value="nanogpt">Nano-GPT</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Embedding Model</label>
              <ModelCombobox
                value={cfg.model}
                onChange={(value) => update({ model: value })}
                models={models}
                modelLabels={modelLabels}
                loading={modelsLoading}
                onRefresh={fetchModels}
                autoRefreshOnFocus
                refreshKey={`${cfg.provider}:${cfg.api_url}`}
                placeholder='Search or enter a model'
                emptyMessage="No models returned for this provider. Enter one manually."
                browseHint="Click into the field to browse embedding-capable models for this provider, or type one manually."
                disabled={inherited}
              />
            </div>
          </div>

          {canEditApiUrl ? (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>API URL</label>
              <input className={styles.select} value={cfg.api_url} onChange={(e) => update({ api_url: e.target.value })} disabled={inherited} />
              <span className={styles.helperText}>
                Auto-appends /v1/embeddings to base domains and /embeddings to partial paths. Full paths ending in /embeddings are used as-is.
              </span>
              {cfg.provider === 'bananabread' && (
                <span className={styles.helperText}>
                  BananaBread defaults to `http://localhost:8008/v1/embeddings` and uses its loaded model list from `/v1/models`.
                </span>
              )}
            </div>
          ) : (
            <div className={styles.field}>
              <label className={styles.fieldLabel}>API Endpoint</label>
              <span className={styles.helperText}>Uses the provider default: `{defaultApiUrl}`</span>
            </div>
          )}

          <div className={styles.settingsGridTwo}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Dimensions (optional)</label>
              <NumericInput
                className={styles.numberInput}
                min={1}
                value={cfg.dimensions ?? null}
                integer
                allowEmpty
                onChange={(value) => update({ dimensions: value })}
              />
            </div>

            {!inherited && (
              <div className={styles.field}>
                <label className={styles.fieldLabel}>API Key {cfg.has_api_key ? '(configured)' : '(not configured)'}</label>
                <input
                  className={styles.select}
                  type="password"
                  value={apiKey}
                  placeholder="Paste a new key to replace"
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </div>
            )}
          </div>

          <Toggle.Checkbox
            checked={cfg.send_dimensions ?? false}
            onChange={(checked) => update({ send_dimensions: checked })}
            label="Send dimensions to provider"
            hint="When enabled, the dimensions value above is included in the embedding API request. Some providers set this automatically from the model and may reject an explicit value."
          />
        </div>
      </div>

      <div className={styles.settingsCard}>
        <div className={styles.settingsCardHeader}>
          <div>
            <div className={styles.subsectionTitle}>World Books</div>
            <div className={styles.settingsCardTitle}>Lorebook indexing and retrieval</div>
            <div className={styles.settingsCardMeta}>Chunking and storage save automatically for your account.</div>
          </div>
          <span className={styles.settingsCardStatus}>
            {worldBookSettingsLoading ? 'Loading...' : worldBookSettingsStatus ?? 'Ready'}
          </span>
        </div>
        <div className={styles.settingsCardBody}>
          <Toggle.Checkbox
            checked={cfg.vectorize_world_books}
            onChange={(checked) => update({ vectorize_world_books: checked })}
            label="Vectorize world book entries"
          />

          <div className={styles.presetRow}>
            {(['lean', 'balanced', 'deep', 'custom'] as WorldBookVectorPresetMode[]).map((preset) => (
              <button
                key={preset}
                type="button"
                className={clsx(styles.presetBtn, worldBookSettings.presetMode === preset && styles.presetBtnActive)}
                onClick={() => applyWorldBookPreset(preset)}
              >
                {preset === 'lean' ? 'Lean' : preset === 'balanced' ? 'Balanced' : preset === 'deep' ? 'Deep' : 'Custom'}
              </button>
            ))}
          </div>
          <span className={styles.helperText}>{worldBookPresetDescriptions[worldBookSettings.presetMode]}</span>

          <div className={styles.settingsGridCompact}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Retrieved Entries</label>
              <NumericInput
                className={styles.numberInput}
                min={1}
                max={20}
                value={worldBookSettings.retrievalTopK}
                disabled={worldBookSettingsLoading || worldBookSettings.presetMode !== 'custom'}
                integer
                onChange={(value) => updateWorldBookSettings({ retrievalTopK: value ?? DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.retrievalTopK })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Chunk Target Tokens</label>
              <NumericInput
                className={styles.numberInput}
                min={120}
                max={2000}
                value={worldBookSettings.chunkTargetTokens}
                disabled={worldBookSettingsLoading || worldBookSettings.presetMode !== 'custom'}
                integer
                onChange={(value) => updateWorldBookSettings({ chunkTargetTokens: value ?? DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.chunkTargetTokens })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Chunk Max Tokens</label>
              <NumericInput
                className={styles.numberInput}
                min={120}
                max={4000}
                value={worldBookSettings.chunkMaxTokens}
                disabled={worldBookSettingsLoading || worldBookSettings.presetMode !== 'custom'}
                integer
                onChange={(value) => updateWorldBookSettings({ chunkMaxTokens: value ?? DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.chunkMaxTokens })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Chunk Overlap Tokens</label>
              <NumericInput
                className={styles.numberInput}
                min={0}
                max={500}
                value={worldBookSettings.chunkOverlapTokens}
                disabled={worldBookSettingsLoading || worldBookSettings.presetMode !== 'custom'}
                integer
                onChange={(value) => updateWorldBookSettings({ chunkOverlapTokens: value ?? 0 })}
              />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Stored Chunks Per Entry</label>
              <NumericInput
                className={styles.numberInput}
                min={1}
                max={24}
                value={worldBookSettings.maxChunksPerEntry}
                disabled={worldBookSettingsLoading || worldBookSettings.presetMode !== 'custom'}
                integer
                onChange={(value) => updateWorldBookSettings({ maxChunksPerEntry: value ?? DEFAULT_WORLD_BOOK_VECTOR_SETTINGS.maxChunksPerEntry })}
              />
            </div>
          </div>

          <div className={styles.settingsGridTwo}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Hybrid Weight Mode</label>
              <select
                className={styles.select}
                value={cfg.hybrid_weight_mode}
                onChange={(e) => update({ hybrid_weight_mode: e.target.value as EmbeddingConfig['hybrid_weight_mode'] })}
              >
                <option value="keyword_first">Keyword First</option>
                <option value="balanced">Balanced</option>
                <option value="vector_first">Vector First</option>
              </select>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Similarity Threshold</label>
              <NumericInput
                className={styles.numberInput}
                min={0}
                max={2}
                step={0.05}
                value={cfg.similarity_threshold}
                onChange={(value) => update({ similarity_threshold: Math.max(0, Math.min(2, value ?? 0)) })}
              />
              <span className={styles.helperText}>0 disables raw-distance filtering.</span>
            </div>
          </div>

          <div className={styles.field}>
            <label className={styles.fieldLabel}>World Book Rerank Cutoff</label>
            <NumericInput
              className={styles.numberInput}
              min={0}
              max={2}
              step={0.01}
              value={cfg.rerank_cutoff}
              onChange={(value) => update({ rerank_cutoff: Math.max(0, Math.min(2, value ?? 0)) })}
            />
            <span className={styles.helperText}>0 disables post-rerank filtering after boosts and penalties are applied.</span>
          </div>
        </div>
      </div>

      <div className={styles.settingsCard}>
        <div className={styles.settingsCardHeader}>
          <div>
            <div className={styles.subsectionTitle}>Runtime</div>
            <div className={styles.settingsCardTitle}>Embedding request behavior</div>
          </div>
        </div>
        <div className={styles.settingsCardBody}>
          <div className={styles.settingsGridTwo}>
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Embedding Batch Size</label>
              <NumericInput
                className={styles.numberInput}
                min={1}
                max={200}
                value={cfg.batch_size}
                integer
                onChange={(value) => update({ batch_size: Math.max(1, Math.min(200, value ?? 50)) })}
              />
              <span className={styles.helperText}>Entries or chunks embedded per request during indexing.</span>
            </div>

            <div className={styles.field}>
              <label className={styles.fieldLabel}>Request Timeout (seconds)</label>
              <NumericInput
                className={styles.numberInput}
                min={0}
                max={300}
                step={5}
                value={cfg.request_timeout ?? 60}
                integer
                onChange={(value) => update({ request_timeout: Math.max(0, Math.min(300, value ?? 60)) })}
              />
              <span className={styles.helperText}>0 disables the timeout.</span>
            </div>
          </div>

          <Toggle.Checkbox
            checked={cfg.vectorize_chat_documents}
            onChange={(checked) => update({ vectorize_chat_documents: checked })}
            label="Vectorize attached chat documents (scaffold)"
          />

          <Toggle.Checkbox
            checked={cfg.vectorize_chat_messages}
            onChange={(checked) => update({ vectorize_chat_messages: checked })}
            label="Vectorize chat messages (long-term memory)"
          />

          {cfg.vectorize_chat_messages && (
            <div className={styles.settingsGridTwo}>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Preferred Context Size (messages)</label>
                <NumericInput
                  className={styles.numberInput}
                  min={1}
                  max={64}
                  value={cfg.preferred_context_size}
                  integer
                  onChange={(value) => update({ preferred_context_size: value ?? 1 })}
                />
              </div>
              <div className={styles.field}>
                <label className={styles.fieldLabel}>Memory Retrieval Mode</label>
                <select
                  className={styles.select}
                  value={cfg.chat_memory_mode}
                  onChange={(e) => update({ chat_memory_mode: e.target.value as EmbeddingConfig['chat_memory_mode'] })}
                >
                  <option value="conservative">Conservative - Fewer, high-quality memories</option>
                  <option value="balanced">Balanced - Standard retrieval (recommended)</option>
                  <option value="aggressive">Aggressive - More memories, lower threshold</option>
                </select>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className={styles.drawerRow}>
        <Button size="sm" onClick={save} disabled={saving || inherited} loading={saving}>
          {saving ? 'Saving...' : 'Save Embedding Settings'}
        </Button>
        <Button size="sm" onClick={test} disabled={testing || saving} loading={testing}>
          {testing ? 'Testing...' : 'Test Embedding API'}
        </Button>
      </div>
      <p className={styles.placeholder}>
        {inherited
          ? 'Testing verifies the inherited embedding connection without changing shared provider settings. World-book chunking and retrieval tuning still save automatically.'
          : 'Testing auto-detects native model dimensions and applies them to this configuration. World-book chunking and retrieval tuning save automatically.'}
      </p>
    </div>
  )
}

interface WebSearchSettingsState {
  enabled: boolean
  provider: 'searxng'
  apiUrl: string
  requestTimeoutMs: number
  defaultResultCount: number
  maxResultCount: number
  maxPagesToScrape: number
  maxCharsPerPage: number
  language: string
  safeSearch: 0 | 1 | 2
  engines: string[]
  hasApiKey: boolean
}

const WEB_SEARCH_DEFAULTS: WebSearchSettingsState = {
  enabled: false,
  provider: 'searxng',
  apiUrl: '',
  requestTimeoutMs: 15000,
  defaultResultCount: 3,
  maxResultCount: 5,
  maxPagesToScrape: 3,
  maxCharsPerPage: 3000,
  language: 'all',
  safeSearch: 1,
  engines: [],
  hasApiKey: false,
}

function WebSearchSettings() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [cfg, setCfg] = useState<WebSearchSettingsState>(WEB_SEARCH_DEFAULTS)
  const [apiKey, setApiKey] = useState('')
  const [testQuery, setTestQuery] = useState('latest AI roleplay tools')
  const [testResult, setTestResult] = useState<WebSearchTestResponse | null>(null)
  const [enginesInput, setEnginesInput] = useState('')

  useEffect(() => {
    webSearchApi.getSettings()
      .then((row) => {
        const next = { ...WEB_SEARCH_DEFAULTS, ...(row || {}) }
        setCfg(next)
        setEnginesInput(Array.isArray(next.engines) ? next.engines.join(', ') : '')
      })
      .catch(() => {
        setCfg(WEB_SEARCH_DEFAULTS)
      })
      .finally(() => setLoading(false))
  }, [])

  const update = (patch: Partial<WebSearchSettingsState>) => {
    setCfg((prev) => ({ ...prev, ...patch }))
  }

  const buildPayload = (): WebSearchSettingsInput => ({
    enabled: cfg.enabled,
    provider: 'searxng',
    apiUrl: cfg.apiUrl,
    requestTimeoutMs: cfg.requestTimeoutMs,
    defaultResultCount: cfg.defaultResultCount,
    maxResultCount: cfg.maxResultCount,
    maxPagesToScrape: cfg.maxPagesToScrape,
    maxCharsPerPage: cfg.maxCharsPerPage,
    language: cfg.language,
    safeSearch: cfg.safeSearch,
    engines: enginesInput.split(',').map((item) => item.trim()).filter(Boolean),
  })

  const save = async () => {
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const payload = buildPayload()
      const next = await webSearchApi.putSettings({
        ...payload,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      })
      setCfg(next)
      setEnginesInput(next.engines.join(', '))
      setApiKey('')
      setSuccess('Web search settings saved')
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Failed to save web search settings')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    setTesting(true)
    setError(null)
    setSuccess(null)
    setTestResult(null)
    try {
      const result = await webSearchApi.test(testQuery, buildPayload(), apiKey.trim() || undefined)
      setTestResult(result)
      setSuccess(`Web search test passed. Retrieved ${result.results.length} results and ${result.documents.length} extracted pages.`)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Web search test failed')
    } finally {
      setTesting(false)
    }
  }

  if (loading) {
    return (
      <div className={styles.settingsSection}>
        <h3 className={styles.sectionTitle}>Web Search</h3>
        <p className={styles.placeholder}>Loading web search settings...</p>
      </div>
    )
  }

  return (
    <div className={styles.settingsSection}>
      <h3 className={styles.sectionTitle}>Web Search</h3>
      <p className={styles.placeholder}>Configure a SearXNG instance for the host-backed council web-search tool. The tool will appear in Council once search is enabled and an API URL is configured.</p>

      {error && <p className={styles.errorText}>{error}</p>}
      {success && <p className={styles.successText}>{success}</p>}

      <Toggle.Checkbox
        checked={cfg.enabled}
        onChange={(checked) => update({ enabled: checked })}
        label="Enable web search"
      />

      <div className={styles.field}>
        <label className={styles.fieldLabel}>Provider</label>
        <select className={styles.select} value={cfg.provider} onChange={() => update({ provider: 'searxng' })}>
          <option value="searxng">SearXNG</option>
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>API URL</label>
        <input className={styles.select} value={cfg.apiUrl} onChange={(e) => update({ apiUrl: e.target.value })} placeholder="https://your-searxng.example.com/search" />
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>API Key {cfg.hasApiKey ? '(configured)' : '(optional)'}</label>
        <input
          className={styles.select}
          type="password"
          value={apiKey}
          placeholder="Paste a new key to replace"
          onChange={(e) => setApiKey(e.target.value)}
        />
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>Engines</label>
        <input className={styles.select} value={enginesInput} onChange={(e) => setEnginesInput(e.target.value)} placeholder="google, brave, duckduckgo" />
        <span className={styles.placeholder} style={{ marginTop: '2px', fontSize: 'calc(11px * var(--lumiverse-font-scale, 1))' }}>
          Optional comma-separated engine allowlist passed through to SearXNG.
        </span>
      </div>

      <div className={styles.drawerRow}>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Language</label>
          <input className={styles.select} value={cfg.language} onChange={(e) => update({ language: e.target.value })} placeholder="all or en-US" />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Safe Search</label>
          <select className={styles.select} value={cfg.safeSearch} onChange={(e) => update({ safeSearch: Number(e.target.value) as 0 | 1 | 2 })}>
            <option value={0}>Off</option>
            <option value={1}>Moderate</option>
            <option value={2}>Strict</option>
          </select>
        </div>
      </div>

      <div className={styles.drawerRow}>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Timeout (ms)</label>
          <NumericInput className={styles.numberInput} min={5000} max={120000} step={1000} value={cfg.requestTimeoutMs} integer onChange={(value) => update({ requestTimeoutMs: Math.max(5000, Math.min(120000, value ?? 15000)) })} />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Default Results</label>
          <NumericInput className={styles.numberInput} min={1} max={10} value={cfg.defaultResultCount} integer onChange={(value) => update({ defaultResultCount: Math.max(1, Math.min(10, value ?? 3)) })} />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Max Results</label>
          <NumericInput className={styles.numberInput} min={1} max={20} value={cfg.maxResultCount} integer onChange={(value) => update({ maxResultCount: Math.max(1, Math.min(20, value ?? 5)) })} />
        </div>
      </div>

      <div className={styles.drawerRow}>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Pages to Scrape</label>
          <NumericInput className={styles.numberInput} min={1} max={10} value={cfg.maxPagesToScrape} integer onChange={(value) => update({ maxPagesToScrape: Math.max(1, Math.min(10, value ?? 3)) })} />
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Chars per Page</label>
          <NumericInput className={styles.numberInput} min={500} max={20000} step={250} value={cfg.maxCharsPerPage} integer onChange={(value) => update({ maxCharsPerPage: Math.max(500, Math.min(20000, value ?? 3000)) })} />
        </div>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel}>Test Query</label>
        <input className={styles.select} value={testQuery} onChange={(e) => setTestQuery(e.target.value)} placeholder="Enter a query to validate this setup" />
      </div>

      <div className={styles.drawerRow}>
        <Button size="sm" onClick={save} disabled={saving} loading={saving}>
          {saving ? 'Saving...' : 'Save Web Search Settings'}
        </Button>
        <Button size="sm" onClick={test} disabled={testing || saving} loading={testing}>
          {testing ? 'Testing...' : 'Test Web Search'}
        </Button>
      </div>

      <p className={styles.placeholder}>Testing uses the current form values, including any unsaved API key override, so you can validate the instance before saving.</p>

      {testResult && (
        <div className={styles.field}>
          <label className={styles.fieldLabel}>Preview</label>
          <div className={styles.placeholder} style={{ whiteSpace: 'pre-wrap', padding: '10px 12px', border: '1px solid var(--lumiverse-border-subtle)', borderRadius: 8, background: 'var(--lumiverse-surface-raised)', maxHeight: 280, overflowY: 'auto' }}>
            {testResult.context}
          </div>
        </div>
      )}
    </div>
  )
}

function ImageOptimizationSettings() {
  const thumbnailSettings = useStore((s) => (s as any).thumbnailSettings as { smallSize?: number, largeSize?: number } | undefined)
  const setSetting = useStore((s) => s.setSetting)

  const smallSize = thumbnailSettings?.smallSize ?? 300
  const largeSize = thumbnailSettings?.largeSize ?? 700

  const [rebuilding, setRebuilding] = useState(false)
  const [rebuildProgress, setRebuildProgress] = useState<{ current: number, total: number } | null>(null)
  const [rebuildStatus, setRebuildStatus] = useState<string | null>(null)

  const update = (patch: { smallSize?: number, largeSize?: number }) => {
    setSetting('thumbnailSettings', { smallSize, largeSize, ...patch })
  }

  const handleRebuild = async () => {
    if (rebuilding) return
    setRebuilding(true)
    setRebuildStatus('Starting...')
    setRebuildProgress(null)
    try {
      const result = await imagesApi.rebuildThumbnails({
        onProgress: (p) => {
          setRebuildProgress({ current: p.current, total: p.total })
          const parts = [`${p.current}/${p.total}`]
          if (p.generated > 0) parts.push(`${p.generated} generated`)
          if (p.skipped > 0) parts.push(`${p.skipped} skipped`)
          if (p.failed > 0) parts.push(`${p.failed} failed`)
          setRebuildStatus(parts.join(' \u2022 '))
        },
      })
      const parts = [`${result.generated} generated`]
      if (result.skipped > 0) parts.push(`${result.skipped} skipped`)
      if (result.failed > 0) parts.push(`${result.failed} failed`)
      setRebuildStatus(`Done — ${parts.join(', ')}`)
    } catch (err: any) {
      setRebuildStatus(`Failed: ${err.message || 'Unknown error'}`)
    } finally {
      setRebuilding(false)
    }
  }

  const pct = rebuildProgress && rebuildProgress.total > 0
    ? Math.round((rebuildProgress.current / rebuildProgress.total) * 100)
    : 0

  return (
    <>
      <p className={styles.placeholder}>
        Control the resolution of generated thumbnail tiers. Smaller values reduce bandwidth; larger values improve visual quality.
      </p>

      <div className={styles.field}>
        <div className={styles.imgOptSliderHeader}>
          <label className={styles.fieldLabel}>Small Tier</label>
          <span className={styles.imgOptSliderValue}>{smallSize}px</span>
        </div>
        <input
          type="range"
          className={styles.imgOptSlider}
          min={100} max={500} step={50}
          value={smallSize}
          onChange={(e) => update({ smallSize: Number(e.target.value) })}
        />
        <span className={styles.placeholder} style={{ fontSize: 11 }}>
          Cards, message avatars, and small UI elements. Default: 300px
        </span>
      </div>

      <div className={styles.field}>
        <div className={styles.imgOptSliderHeader}>
          <label className={styles.fieldLabel}>Large Tier</label>
          <span className={styles.imgOptSliderValue}>{largeSize}px</span>
        </div>
        <input
          type="range"
          className={styles.imgOptSlider}
          min={400} max={1200} step={50}
          value={largeSize}
          onChange={(e) => update({ largeSize: Number(e.target.value) })}
        />
        <span className={styles.placeholder} style={{ fontSize: 11 }}>
          Portrait panel, character editor, and profile views. Default: 700px
        </span>
      </div>

      <div className={styles.imgOptRebuild}>
        <div className={styles.field} style={{ flex: 1 }}>
          <label className={styles.fieldLabel}>Rebuild Thumbnail Cache</label>
          <span className={styles.placeholder} style={{ fontSize: 11 }}>
            Regenerate all thumbnails at the current tier sizes.
          </span>
        </div>
        <button
          type="button"
          className={clsx(styles.segmentedBtn, styles.segmentedBtnActive)}
          style={{ padding: '6px 16px', whiteSpace: 'nowrap' }}
          disabled={rebuilding}
          onClick={handleRebuild}
        >
          {rebuilding ? 'Rebuilding...' : 'Rebuild Thumbnails'}
        </button>
      </div>
      {rebuilding && rebuildProgress && rebuildProgress.total > 0 && (
        <div style={{ width: '100%', height: 4, borderRadius: 2, background: 'var(--lumiverse-fill-subtle)', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', borderRadius: 2, background: 'var(--lumiverse-primary)', transition: 'width 0.2s ease' }} />
        </div>
      )}
      {rebuildStatus && (
        <span className={styles.placeholder} style={{ fontSize: 11 }}>
          {rebuildStatus}
        </span>
      )}
    </>
  )
}

function AdvancedSettings() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [cfg, setCfg] = useState<ChatMemorySettings | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const settings = await embeddingsApi.getChatMemorySettings()
      setCfg(settings)
      // Mark as loaded so auto-save doesn't fire on initial load
      setTimeout(() => { loadedRef.current = true }, 50)
    } catch (err: any) {
      setError(err?.body?.error || err?.message || 'Failed to load chat memory settings')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const quickModePresets: Record<string, Pick<ChatMemorySettings, 'chunkTargetTokens' | 'chunkMaxTokens' | 'chunkOverlapTokens' | 'exclusionWindow'>> = {
    conservative: { chunkTargetTokens: 600, chunkMaxTokens: 1200, chunkOverlapTokens: 100, exclusionWindow: 30 },
    balanced: { chunkTargetTokens: 800, chunkMaxTokens: 1600, chunkOverlapTokens: 120, exclusionWindow: 20 },
    aggressive: { chunkTargetTokens: 1000, chunkMaxTokens: 2000, chunkOverlapTokens: 200, exclusionWindow: 15 },
  }

  const loadedRef = useRef(false)
  const dirtyRef = useRef(false)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const update = (patch: Partial<ChatMemorySettings>) => {
    if (!cfg) return
    const next = { ...cfg, ...patch }
    // When switching to a quick mode, overlay its preset values so the UI reflects them
    if (patch.quickMode && patch.quickMode in quickModePresets) {
      Object.assign(next, quickModePresets[patch.quickMode])
    }
    dirtyRef.current = true
    setCfg(next)
  }

  // Auto-save on change with debounce
  useEffect(() => {
    if (!cfg || !loadedRef.current || !dirtyRef.current) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(async () => {
      dirtyRef.current = false
      setSaving(true)
      setError(null)
      try {
        await embeddingsApi.updateChatMemorySettings(cfg)
        setSuccess('Settings saved')
        setTimeout(() => setSuccess(null), 1500)
      } catch (err: any) {
        setError(err?.body?.error || err?.message || 'Failed to save')
      } finally {
        setSaving(false)
      }
    }, 600)
    return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current) }
  }, [cfg])

  return (
    <div className={styles.settingsSection}>
      <h3 className={styles.sectionTitle}>Advanced</h3>

      {/* Image Optimization accordion */}
      <CollapsibleSection title="Image Optimization" defaultExpanded={false}>
        <ImageOptimizationSettings />
      </CollapsibleSection>

      {/* Long-Term Memory accordion */}
      <CollapsibleSection title="Long-Term Chat Memory" defaultExpanded>
        {loading || !cfg ? (
          <p className={styles.placeholder}>Loading memory settings...</p>
        ) : (
          <>
            {error && <p className={styles.errorText}>{error}</p>}
            {success && <p className={styles.successText}>{success}</p>}

            {/* Quick Mode / Manual toggle */}
            <div className={styles.field}>
              <label className={styles.fieldLabel}>Memory Mode</label>
              <div className={styles.segmented}>
                {(['conservative', 'balanced', 'aggressive', null] as const).map((mode) => (
                  <button
                    key={mode ?? 'manual'}
                    type="button"
                    className={clsx(styles.segmentedBtn, cfg.quickMode === mode && styles.segmentedBtnActive)}
                    onClick={() => update({ quickMode: mode })}
                  >
                    {mode === null ? 'Manual' : mode.charAt(0).toUpperCase() + mode.slice(1)}
                  </button>
                ))}
              </div>
              <span className={styles.placeholder} style={{ marginTop: 2, fontSize: 11 }}>
                Quick presets auto-configure chunking & exclusion. "Manual" unlocks all fields below.
              </span>
            </div>

            {/* Section: Chunking */}
            <CollapsibleSection title="Chunking" defaultExpanded={false}>
              <div className={styles.memoryGrid}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Target Tokens</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={200} max={2000}
                    value={cfg.chunkTargetTokens}
                    disabled={cfg.quickMode !== null}
                    integer
                    onChange={(value) => update({ chunkTargetTokens: value ?? 800 })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Max Tokens</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={400} max={4000}
                    value={cfg.chunkMaxTokens}
                    disabled={cfg.quickMode !== null}
                    integer
                    onChange={(value) => update({ chunkMaxTokens: value ?? 1600 })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Overlap Tokens</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={0} max={500}
                    value={cfg.chunkOverlapTokens}
                    disabled={cfg.quickMode !== null}
                    integer
                    onChange={(value) => update({ chunkOverlapTokens: value ?? 0 })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Max Messages / Chunk</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={0} max={100}
                    value={cfg.maxMessagesPerChunk}
                    integer
                    onChange={(value) => update({ maxMessagesPerChunk: value ?? 0 })}
                  />
                  <span className={styles.placeholder} style={{ fontSize: 11 }}>0 = unlimited</span>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Time Gap Split (min)</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={0} max={1440}
                    value={cfg.splitOnTimeGapMinutes}
                    integer
                    onChange={(value) => update({ splitOnTimeGapMinutes: value ?? 0 })}
                  />
                  <span className={styles.placeholder} style={{ fontSize: 11 }}>0 = disabled</span>
                </div>
              </div>

              <Toggle.Checkbox
                checked={cfg.splitOnSceneBreaks}
                onChange={(checked) => update({ splitOnSceneBreaks: checked })}
                label="Split on scene breaks (---, ***, ===)"
              />
            </CollapsibleSection>

            {/* Section: Retrieval */}
            <CollapsibleSection title="Retrieval" defaultExpanded={false}>
              <div className={styles.memoryGrid}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Top-K Results</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={1}
                    value={cfg.retrievalTopK}
                    integer
                    onChange={(value) => update({ retrievalTopK: value ?? 4 })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Exclusion Window</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={5} max={100}
                    value={cfg.exclusionWindow}
                    disabled={cfg.quickMode !== null}
                    integer
                    onChange={(value) => update({ exclusionWindow: value ?? 20 })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Similarity Threshold</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={0} max={2} step={0.05}
                    value={cfg.similarityThreshold}
                    onChange={(value) => update({ similarityThreshold: Math.max(0, Math.min(2, value ?? 0)) })}
                  />
                  <span className={styles.placeholder} style={{ fontSize: 11 }}>
                    0 = no filtering. Cosine distance can exceed 1, so useful cutoffs are not limited to 0–1.
                  </span>
                </div>
              </div>
            </CollapsibleSection>

            {/* Section: Query */}
            <CollapsibleSection title="Query" defaultExpanded={false}>
              <div className={styles.memoryGrid}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Query Strategy</label>
                  <select
                    className={styles.select}
                    value={cfg.queryStrategy}
                    onChange={(e) => update({ queryStrategy: e.target.value as ChatMemorySettings['queryStrategy'] })}
                  >
                    <option value="recent_messages">Recent Messages</option>
                    <option value="last_user_message">Last User Message</option>
                    <option value="weighted_recent">Weighted Recent</option>
                  </select>
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Query Context Size</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={1} max={64}
                    value={cfg.queryContextSize}
                    integer
                    onChange={(value) => update({ queryContextSize: value ?? 6 })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Query Max Tokens</label>
                  <NumericInput
                    className={styles.numberInput}
                    min={1000} max={32000}
                    value={cfg.queryMaxTokens}
                    integer
                    onChange={(value) => update({ queryMaxTokens: value ?? 8000 })}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {/* Section: Formatting */}
            <CollapsibleSection title="Formatting" defaultExpanded={false}>
              <span className={styles.placeholder} style={{ fontSize: 11, marginBottom: 4 }}>
                Templates control how retrieved memories appear in the prompt. Available placeholders: {'{{memories}}'}, {'{{content}}'}, {'{{score}}'}, {'{{startIndex}}'}, {'{{endIndex}}'}.
              </span>

              <div className={styles.field}>
                <label className={styles.fieldLabel}>Header Template</label>
                <textarea
                  className={styles.textarea}
                  rows={2}
                  value={cfg.memoryHeaderTemplate}
                  onChange={(e) => update({ memoryHeaderTemplate: e.target.value })}
                />
              </div>

              <div className={styles.drawerRow}>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Chunk Template</label>
                  <input
                    className={styles.select}
                    value={cfg.chunkTemplate}
                    onChange={(e) => update({ chunkTemplate: e.target.value })}
                  />
                </div>
                <div className={styles.field}>
                  <label className={styles.fieldLabel}>Chunk Separator</label>
                  <input
                    className={styles.select}
                    value={cfg.chunkSeparator}
                    onChange={(e) => update({ chunkSeparator: e.target.value })}
                  />
                </div>
              </div>
            </CollapsibleSection>

            {saving && <p className={styles.placeholder} style={{ marginTop: 8, fontSize: 11 }}>Saving...</p>}
          </>
        )}
      </CollapsibleSection>
    </div>
  )
}

function LumiHubSettings() {
  const user = useStore((s) => s.user)
  const defaultInstanceName = user?.name ? `${user.name}'s Lumiverse` : 'My Lumiverse'
  const [lumihubUrl, setLumihubUrl] = useState('https://lumi.spot')
  const [instanceName, setInstanceName] = useState(defaultInstanceName)
  const [status, setStatus] = useState<{
    linked: boolean
    lumihub_url?: string
    instance_name?: string
    connected?: boolean
    last_connected_at?: string | null
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [linking, setLinking] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const fetchStatus = async () => {
    try {
      const res = await fetch('/api/v1/lumihub/status', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json()
        setStatus(data)
        if (data.lumihub_url) setLumihubUrl(data.lumihub_url)
        if (data.instance_name) setInstanceName(data.instance_name)
      }
    } catch {
      // ignore
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchStatus()
    const interval = setInterval(fetchStatus, 10_000)
    return () => clearInterval(interval)
  }, [])

  const handleLink = async () => {
    if (!lumihubUrl.trim()) {
      setError('Enter your LumiHub URL')
      return
    }
    setError(null)
    setLinking(true)
    try {
      const res = await fetch('/api/v1/lumihub/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ lumihub_url: lumihubUrl.trim(), instance_name: instanceName.trim() || 'My Lumiverse', redirect_origin: window.location.origin }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        setError((body as any).error || 'Failed to start linking')
        return
      }
      const data = await res.json() as { authorize_url: string }
      window.open(data.authorize_url, '_blank')
      // Poll for status change
      const poll = setInterval(async () => {
        const checkRes = await fetch('/api/v1/lumihub/status', { credentials: 'include' })
        if (checkRes.ok) {
          const checkData = await checkRes.json()
          if (checkData.linked) {
            clearInterval(poll)
            setStatus(checkData)
            setLinking(false)
          }
        }
      }, 2000)
      // Stop polling after 5 minutes
      setTimeout(() => { clearInterval(poll); setLinking(false) }, 5 * 60 * 1000)
    } catch (err: any) {
      setError(err.message || 'Failed to connect to LumiHub')
      setLinking(false)
    }
  }

  const handleUnlink = async () => {
    setUnlinking(true)
    try {
      await fetch('/api/v1/lumihub/unlink', { method: 'POST', credentials: 'include' })
      setStatus({ linked: false })
      setLumihubUrl('')
    } catch {
      setError('Failed to unlink')
    } finally {
      setUnlinking(false)
    }
  }

  if (loading) {
    return (
      <div className={styles.settingsSection}>
        <h3 className={styles.sectionTitle}>LumiHub</h3>
        <span className={styles.helperText}>Loading...</span>
      </div>
    )
  }

  return (
    <div className={styles.settingsSection}>
      <h3 className={styles.sectionTitle}>LumiHub</h3>
      <span className={styles.helperText}>
        Link this Lumiverse instance to LumiHub to install characters directly from the web.
      </span>

      {status?.linked ? (
        <div className={styles.lumihubCard}>
          <div className={styles.lumihubStatusRow}>
            <span className={clsx(styles.lumihubDot, status.connected ? styles.lumihubDotOnline : styles.lumihubDotOffline)} />
            <span className={styles.lumihubStatusText}>
              {status.connected ? 'Connected' : 'Disconnected'} — {status.instance_name}
            </span>
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>LumiHub URL</span>
            <span className={styles.lumihubMeta}>{status.lumihub_url}</span>
          </div>

          {status.last_connected_at && (
            <div className={styles.field}>
              <span className={styles.fieldLabel}>Last Connected</span>
              <span className={styles.lumihubMeta}>
                {new Date(status.last_connected_at).toLocaleString()}
              </span>
            </div>
          )}

          <div className={styles.lumihubDisclosure}>
            <span className={styles.lumihubDisclosureTitle}>Manifest Sync</span>
            <span className={styles.lumihubDisclosureText}>
              A basic manifest of your installed characters (names and creators only) is synced to your LumiHub account to enable remote card updates. No chat data, messages, or personal content is ever shared. Lumiverse and LumiHub developers cannot access your data. Third-party LumiHub instances may have different privacy practices — exercise caution.
            </span>
          </div>

          <Button
            variant="danger-ghost"
            size="sm"
            onClick={handleUnlink}
            disabled={unlinking}
            loading={unlinking}
          >
            {unlinking ? 'Unlinking...' : 'Unlink from LumiHub'}
          </Button>
        </div>
      ) : (
        <div className={styles.lumihubCard}>
          <div className={styles.field}>
            <span className={styles.fieldLabel}>LumiHub URL</span>
            <input
              className={styles.lumihubInput}
              type="text"
              placeholder="https://lumi.spot"
              value={lumihubUrl}
              onChange={(e) => setLumihubUrl(e.target.value)}
            />
          </div>

          <div className={styles.field}>
            <span className={styles.fieldLabel}>Instance Name</span>
            <input
              className={styles.lumihubInput}
              type="text"
              placeholder="My Lumiverse"
              value={instanceName}
              onChange={(e) => setInstanceName(e.target.value)}
            />
            <span className={styles.helperText}>
              A label to identify this instance on LumiHub (e.g. &quot;Home PC&quot;, &quot;Laptop&quot;)
            </span>
          </div>

          <button
            className={styles.lumihubPrimaryBtn}
            onClick={handleLink}
            disabled={linking}
          >
            {linking ? 'Waiting for approval...' : 'Link to LumiHub'}
          </button>
        </div>
      )}

      {error && <span className={styles.errorText}>{error}</span>}
    </div>
  )
}
