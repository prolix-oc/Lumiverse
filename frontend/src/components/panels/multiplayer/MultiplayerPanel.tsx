import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { useTranslation } from 'react-i18next'
import { Crown, UserCheck, SkipForward, UserX, Ban, LogOut, Copy, Loader2, Globe } from 'lucide-react'
import { useStore } from '@/store'
import { wsClient } from '@/ws/client'
import { relayClient } from '@/ws/relayClient'
import { multiplayerApi } from '@/api/multiplayer'
import { buildActivePersonaSnapshot } from '@/lib/personaSnapshot'
import { buildCharacterAvatarSnapshot } from '@/lib/characterAvatarSnapshot'
import { copyTextToClipboard } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import type { RoomParticipant, TurnStrategy } from '@/types/multiplayer'

const card: React.CSSProperties = {
  border: '1px solid var(--lumiverse-border)',
  borderRadius: 10,
  padding: 12,
  marginBottom: 12,
  background: 'var(--lumiverse-surface, rgba(255,255,255,0.02))',
}
const btn: React.CSSProperties = {
  border: '1px solid var(--lumiverse-border)',
  borderRadius: 8,
  padding: '6px 12px',
  background: 'transparent',
  color: 'var(--lumiverse-text)',
  cursor: 'pointer',
  fontSize: 13,
}
const primaryBtn: React.CSSProperties = {
  ...btn,
  background: 'var(--lumiverse-accent, #6366f1)',
  borderColor: 'transparent',
  color: '#fff',
  fontWeight: 600,
}
const iconBtn: React.CSSProperties = {
  ...btn,
  padding: 5,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
}
const label: React.CSSProperties = { fontSize: 12, color: 'var(--lumiverse-text-secondary)', marginBottom: 4 }

function FreeformCountdown({ deadline }: { deadline: number | null }) {
  const { t } = useTranslation('panels')
  const [now, setNow] = useState(() => Date.now() / 1000)
  useEffect(() => {
    if (deadline == null) return
    const id = setInterval(() => setNow(Date.now() / 1000), 250)
    return () => clearInterval(id)
  }, [deadline])
  if (deadline == null) return <span>{t('multiplayerPanel.freeformWindowClosed')}</span>
  const remaining = Math.max(0, Math.ceil(deadline - now))
  return (
    <span>
      {remaining > 0
        ? t('multiplayerPanel.freeformSecondsLeft', { count: remaining })
        : t('multiplayerPanel.freeformGenerating')}
    </span>
  )
}

function Avatar({ p }: { p: RoomParticipant }) {
  const url = p.persona?.avatarUrl
  const initial = (p.persona?.name || p.displayName || '?').charAt(0).toUpperCase()
  return url ? (
    <img
      src={url}
      alt=""
      width={32}
      height={32}
      style={{ width: 32, height: 32, borderRadius: '50%', objectFit: 'cover', flexShrink: 0 }}
    />
  ) : (
    <div
      style={{
        width: 32, height: 32, borderRadius: '50%', flexShrink: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--lumiverse-accent, #6366f1)', color: '#fff', fontSize: 14, fontWeight: 600,
      }}
    >
      {initial}
    </div>
  )
}

export default function MultiplayerPanel() {
  const { t } = useTranslation('panels')
  const activeChatId = useStore((s) => s.activeChatId)
  const roomId = useStore((s) => s.mpRoomId)
  const mpChatId = useStore((s) => s.mpChatId)
  const isHost = useStore((s) => s.mpIsHost)
  const participants = useStore((s) => s.mpParticipants)
  const turnStrategy = useStore((s) => s.mpTurnStrategy)
  const currentTurnId = useStore((s) => s.mpCurrentTurnParticipantId)
  const round = useStore((s) => s.mpRound)
  const freeformDeadline = useStore((s) => s.mpFreeformDeadline)
  const mpSettings = useStore((s) => s.mpSettings)
  const myParticipantId = useStore((s) => s.mpMyParticipantId)
  const setRoomState = useStore((s) => s.setRoomState)
  const clearRoom = useStore((s) => s.clearRoom)
  const setCharacterAvatar = useStore((s) => s.setCharacterAvatar)
  const setActiveChat = useStore((s) => s.setActiveChat)
  const activeCharacterId = useStore((s) => s.activeCharacterId)
  const activeChatMetadata = useStore((s) => s.activeChatMetadata)
  // A "joined room" shadow chat (recorded when this user joined someone else's
  // remote room) carries a durable reconnect credential → offer a Rejoin button.
  const joinedRoom = activeChatMetadata?.joined_room as
    | { roomId?: string; characterName?: string; remote?: boolean }
    | undefined
  const navigate = useNavigate()
  const lastNavRef = useRef<string | null>(null)

  // Pull the user into the room's chat view when they join (host → the fork,
  // peer → the host's chat). ChatView renders from the route param, so a store
  // change alone isn't enough — we navigate once per room session.
  useEffect(() => {
    if (mpChatId && lastNavRef.current !== mpChatId) {
      lastNavRef.current = mpChatId
      navigate('/chat/' + mpChatId)
    } else if (!mpChatId) {
      lastNavRef.current = null
    }
  }, [mpChatId, navigate])

  const [strategy, setStrategy] = useState<TurnStrategy>('round_robin')
  // Kept as a string so the field can be cleared / freely edited; clamped to
  // [10, 3600] only at send time (a raw number input snapped empty values back
  // to 120, which made larger values awkward/impossible to enter).
  const [windowSec, setWindowSec] = useState('120')
  // In-room editable freeform window duration (synced from the room's setting),
  // changeable only while no window is open.
  const [windowEdit, setWindowEdit] = useState('120')
  // Max participants (peers), 1–8. Configurable at create time.
  const [maxPeers, setMaxPeers] = useState('8')
  const [joinId, setJoinId] = useState('')
  const [busy, setBusy] = useState(false)
  // Lives in the store (not local state) so the ROOM_INVITE_CODE handler can
  // auto-roll it when a guest redeems the current code.
  const remoteCode = useStore((s) => s.mpRemoteCode)
  const setRemoteCode = useStore((s) => s.setRemoteCode)

  // Keep the in-room window-duration field in sync with the room's setting.
  useEffect(() => {
    if (mpSettings?.freeformWindowSec) setWindowEdit(String(mpSettings.freeformWindowSec))
  }, [mpSettings?.freeformWindowSec])

  // Host opens a freeform window, applying any (only-while-ended) duration change.
  const openWindow = useCallback(async () => {
    if (!roomId) return
    setBusy(true)
    try {
      const sec = Math.min(3600, Math.max(10, parseInt(windowEdit, 10) || 120))
      if (sec !== mpSettings?.freeformWindowSec) {
        await multiplayerApi.update(roomId, { settings: { freeformWindowSec: sec } })
      }
      await multiplayerApi.startFreeform(roomId)
    } catch {
      toast.error(t('multiplayerPanel.toastOpenWindowFailed'))
    } finally {
      setBusy(false)
    }
  }, [roomId, windowEdit, mpSettings, t])

  // Register with the Identity Server + open the relay bridge + mint a shareable
  // code, so the room is immediately "listening" for remote invites. Best-effort:
  // if remote isn't configured/reachable, the room still works locally.
  const startListening = useCallback(async (rid: string) => {
    try {
      await multiplayerApi.enableRemote(rid)
      const inv = await multiplayerApi.remoteInvite(rid)
      setRemoteCode(inv.code)
    } catch {
      /* remote unavailable — local room still works */
    }
  }, [setRemoteCode])

  const hostCreate = useCallback(async () => {
    if (!activeChatId) return
    setBusy(true)
    try {
      const snap = await buildActivePersonaSnapshot()
      // Compress the bot avatar so peers (who can't fetch the owner-scoped
      // character-avatar endpoint) can render it.
      const characterAvatar = await buildCharacterAvatarSnapshot(activeCharacterId)
      setCharacterAvatar(characterAvatar)
      // Clamp to the backend's accepted ranges (empty → defaults).
      const freeformWindowSec = Math.min(3600, Math.max(10, parseInt(windowSec, 10) || 120))
      const max = Math.min(8, Math.max(1, parseInt(maxPeers, 10) || 8))
      // Backend forks the current chat and returns the room on the new fork.
      const view = await multiplayerApi.create({
        chat_id: activeChatId,
        turn_strategy: strategy,
        settings: { maxPeers: max, ...(strategy === 'freeform' ? { freeformWindowSec } : {}) },
      })
      setRoomState(view, { isHost: true })
      // Switch to the forked multiplayer chat (the original is preserved).
      setActiveChat(view.chatId, activeCharacterId)
      // Subscribe the host's socket to the room topic + register the host
      // participant under their current persona name + avatar, and relay the
      // bot avatar for peers.
      wsClient.send({ type: 'room_join', roomId: view.roomId, displayName: snap?.name, persona: snap, characterAvatar })
      toast.success(t('multiplayerPanel.toastRoomCreated'))
      void startListening(view.roomId)
    } catch {
      toast.error(t('multiplayerPanel.toastCreateFailed'))
    } finally {
      setBusy(false)
    }
  }, [activeChatId, strategy, windowSec, maxPeers, setRoomState, setActiveChat, activeCharacterId, startListening, setCharacterAvatar, t])

  // After a refresh the store forgets the room but the backend still has it.
  // Re-adopt it (and re-subscribe the socket) so the host isn't offered a
  // duplicate create (which 409s).
  useEffect(() => {
    if (!activeChatId || roomId) return
    let cancelled = false
    multiplayerApi
      .byChat(activeChatId)
      .then(async (res) => {
        if (cancelled || !res.room) return
        const snap = await buildActivePersonaSnapshot()
        const characterAvatar = await buildCharacterAvatarSnapshot(activeCharacterId)
        if (cancelled) return
        setCharacterAvatar(characterAvatar)
        setRoomState(res.room, { isHost: true })
        wsClient.send({ type: 'room_join', roomId: res.room.roomId, displayName: snap?.name, persona: snap, characterAvatar })
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [activeChatId, roomId, setRoomState, activeCharacterId, setCharacterAvatar])

  const join = useCallback(async () => {
    const input = joinId.trim()
    if (!input) return
    const isRoomId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input)
    clearRoom()
    setBusy(true)
    try {
      const snap = await buildActivePersonaSnapshot()
      if (isRoomId) {
        // Same-server / LAN: join by room id over our own socket.
        wsClient.send({ type: 'room_join', roomId: input, displayName: snap?.name, persona: snap })
        setJoinId('')
        return
      }
      // Remote: redeem the one-time code (consumes it), THEN connect to the relay.
      // Split so a redeem failure (bad/expired code) reads differently from a
      // post-redeem connection failure — the code is already spent in the latter.
      let grant
      try {
        grant = await multiplayerApi.joinByCode(input, snap?.name)
      } catch {
        toast.error(t('multiplayerPanel.toastInvalidInvite'))
        return
      }
      try {
        // Connection problems (host offline, relay unreachable) surface via the
        // relay client's join timeout, not here — this only catches a sync throw
        // (e.g. a malformed relay URL).
        relayClient.connect(grant, { displayName: snap?.name, persona: snap })
        setJoinId('')
      } catch {
        toast.error(t('multiplayerPanel.toastRelayUnreachable'))
      }
    } finally {
      setBusy(false)
    }
  }, [joinId, clearRoom, t])

  // Rejoin a remote room previously joined from history, using the durable
  // reconnect token the backend stored on this shadow chat — no new invite code.
  const rejoin = useCallback(async () => {
    if (!activeChatId) return
    setBusy(true)
    try {
      const snap = await buildActivePersonaSnapshot()
      const grant = await multiplayerApi.reconnect(activeChatId)
      relayClient.connect(grant, { displayName: snap?.name, persona: snap })
    } catch {
      toast.error(t('multiplayerPanel.toastRejoinFailed'))
    } finally {
      setBusy(false)
    }
  }, [activeChatId, t])

  const enableRemote = useCallback(async () => {
    if (!roomId) return
    setBusy(true)
    try {
      await multiplayerApi.enableRemote(roomId)
      const inv = await multiplayerApi.remoteInvite(roomId)
      setRemoteCode(inv.code)
      toast.success(t('multiplayerPanel.toastRemoteEnabled'))
    } catch {
      toast.error(t('multiplayerPanel.toastRemoteUnavailable'))
    } finally {
      setBusy(false)
    }
  }, [roomId, setRemoteCode, t])

  const copyText = useCallback(async (text: string, labelText: string) => {
    try {
      await copyTextToClipboard(text)
      toast.success(t('multiplayerPanel.toastCopied', { label: labelText }))
    } catch {
      toast.error(t('multiplayerPanel.toastCopyFailed'))
    }
  }, [t])

  const leave = useCallback(() => {
    if (isHost && roomId) {
      multiplayerApi.close(roomId).catch(() => {})
    } else if (relayClient.isActive()) {
      relayClient.send({ type: 'room_leave' })
      relayClient.disconnect()
    } else {
      wsClient.send({ type: 'room_leave', roomId })
    }
    clearRoom()
  }, [isHost, roomId, clearRoom])

  // ── No active room: host or join ──
  if (!roomId) {
    return (
      <div style={{ padding: 12 }}>
        {joinedRoom?.remote && (
          <div style={card}>
            <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{t('multiplayerPanel.rejoinTitle')}</h3>
            <p style={{ color: 'var(--lumiverse-text-secondary)', fontSize: 13, margin: '0 0 10px' }}>
              {t('multiplayerPanel.rejoinHint')}
            </p>
            <button style={primaryBtn} onClick={rejoin} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : t('multiplayerPanel.rejoin')}
            </button>
          </div>
        )}
        <div style={card}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>{t('multiplayerPanel.hostTitle')}</h3>
          {!activeChatId ? (
            <p style={{ color: 'var(--lumiverse-text-secondary)', fontSize: 13 }}>
              {t('multiplayerPanel.openChatFirst')}
            </p>
          ) : (
            <>
              <div style={label}>{t('multiplayerPanel.turnStrategy')}</div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                {(['round_robin', 'freeform'] as TurnStrategy[]).map((s) => (
                  <button
                    key={s}
                    style={strategy === s ? primaryBtn : btn}
                    onClick={() => setStrategy(s)}
                  >
                    {s === 'round_robin' ? t('multiplayerPanel.roundRobin') : t('multiplayerPanel.freeform')}
                  </button>
                ))}
              </div>
              <div style={{ marginBottom: 10 }}>
                <div style={label}>{t('multiplayerPanel.maxParticipants')}</div>
                <input
                  type="number"
                  min={1}
                  max={8}
                  value={maxPeers}
                  onChange={(e) => setMaxPeers(e.target.value)}
                  style={{ ...btn, width: 100, cursor: 'text' }}
                />
              </div>
              {strategy === 'freeform' && (
                <div style={{ marginBottom: 10 }}>
                  <div style={label}>{t('multiplayerPanel.windowSeconds')}</div>
                  <input
                    type="number"
                    min={10}
                    max={3600}
                    value={windowSec}
                    onChange={(e) => setWindowSec(e.target.value)}
                    style={{ ...btn, width: 100, cursor: 'text' }}
                  />
                </div>
              )}
              <button style={primaryBtn} onClick={hostCreate} disabled={busy}>
                {busy ? <Loader2 size={14} className="spin" /> : t('multiplayerPanel.createRoom')}
              </button>
            </>
          )}
        </div>

        <div style={card}>
          <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>{t('multiplayerPanel.joinTitle')}</h3>
          <div style={label}>{t('multiplayerPanel.joinHint')}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              value={joinId}
              onChange={(e) => setJoinId(e.target.value)}
              placeholder={t('multiplayerPanel.joinPlaceholder')}
              style={{ ...btn, flex: 1, cursor: 'text' }}
            />
            <button style={primaryBtn} onClick={join} disabled={!joinId.trim() || busy}>
              {busy ? <Loader2 size={14} className="spin" /> : t('multiplayerPanel.join')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── In a room ──
  return (
    <div style={{ padding: 12 }}>
      <div style={card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0, fontSize: 14 }}>
            {isHost ? t('multiplayerPanel.hosting') : t('multiplayerPanel.inRoom')} ·{' '}
            {turnStrategy === 'round_robin' ? t('multiplayerPanel.roundRobin') : t('multiplayerPanel.freeform')}
          </h3>
          <button style={{ ...btn, color: 'var(--lumiverse-danger, #ef4444)' }} onClick={leave}>
            <LogOut size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            {isHost ? t('multiplayerPanel.close') : t('multiplayerPanel.leave')}
          </button>
        </div>
        <div style={{ ...label, marginTop: 6 }}>
          {turnStrategy === 'round_robin' ? (
            currentTurnId === myParticipantId ? (
              <strong style={{ color: 'var(--lumiverse-accent, #6366f1)' }}>{t('multiplayerPanel.yourTurn')}</strong>
            ) : (
              <>
                {t('multiplayerPanel.waitingFor', {
                  name: participants.find((p) => p.id === currentTurnId)?.displayName || t('multiplayerPanel.hostFallbackName'),
                  round: round + 1,
                })}
              </>
            )
          ) : (
            <FreeformCountdown deadline={freeformDeadline} />
          )}
        </div>
        {isHost && turnStrategy === 'freeform' && (
          freeformDeadline == null ? (
            // Window ended → the duration can be changed before (re)opening.
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
              <input
                type="number"
                min={10}
                max={3600}
                value={windowEdit}
                onChange={(e) => setWindowEdit(e.target.value)}
                aria-label={t('multiplayerPanel.freeformWindowAria')}
                style={{ ...btn, width: 72, cursor: 'text' }}
              />
              <span style={{ ...label, marginBottom: 0 }}>{t('multiplayerPanel.secondsShort')}</span>
              <button style={primaryBtn} onClick={openWindow} disabled={busy}>
                {t('multiplayerPanel.openWindow')}
              </button>
            </div>
          ) : (
            // Window open → duration is locked; only ending is offered.
            <div style={{ marginTop: 8 }}>
              <button style={btn} onClick={() => multiplayerApi.endFreeform(roomId).catch(() => {})}>
                {t('multiplayerPanel.endNow')}
              </button>
            </div>
          )
        )}
      </div>

      {isHost && (
        <div style={card}>
          <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>{t('multiplayerPanel.inviteTitle')}</h3>
          <div style={label}>{t('multiplayerPanel.roomIdHint')}</div>
          <code style={{ display: 'block', fontSize: 12, wordBreak: 'break-all', marginBottom: 8 }}>{roomId}</code>
          <button style={btn} onClick={() => copyText(roomId!, t('multiplayerPanel.roomIdLabel'))}>
            <Copy size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
            {t('multiplayerPanel.copyRoomId')}
          </button>

          <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--lumiverse-border)' }}>
            {remoteCode ? (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, fontWeight: 600, marginBottom: 2 }}>
                  <Globe size={14} style={{ flexShrink: 0 }} />
                  {t('multiplayerPanel.listeningTitle')}
                </div>
                <div style={{ ...label, marginBottom: 8, lineHeight: 1.4 }}>
                  {t('multiplayerPanel.inviteCodeHint')}
                </div>
                <code style={{ display: 'block', fontSize: 16, fontWeight: 700, letterSpacing: 1, wordBreak: 'break-all', marginBottom: 8 }}>
                  {remoteCode}
                </code>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button style={btn} onClick={() => copyText(remoteCode, t('multiplayerPanel.inviteCodeLabel'))}>
                    <Copy size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                    {t('multiplayerPanel.copyCode')}
                  </button>
                  <button style={btn} onClick={enableRemote} disabled={busy}>
                    {t('multiplayerPanel.newCode')}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div style={{ ...label, lineHeight: 1.4 }}>{t('multiplayerPanel.enableRemoteHint')}</div>
                <button style={btn} onClick={enableRemote} disabled={busy}>
                  <Globe size={13} style={{ verticalAlign: -2, marginRight: 4 }} />
                  {t('multiplayerPanel.enableRemote')}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      <div style={card}>
        <h3 style={{ margin: '0 0 10px', fontSize: 14 }}>{t('multiplayerPanel.membersTitle', { count: participants.length })}</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {participants.map((p) => (
            <div key={p.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Avatar p={p} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                  {p.persona?.name || p.displayName || t('multiplayerPanel.guest')}
                  {p.role === 'host' && <Crown size={12} style={{ color: 'var(--lumiverse-accent, #6366f1)' }} />}
                  {p.isCurrentTurn && (
                    <span style={{ fontSize: 10, color: 'var(--lumiverse-accent, #6366f1)', fontWeight: 700 }}>
                      {t('multiplayerPanel.turnBadge')}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: 'var(--lumiverse-text-secondary)' }}>
                  {p.typing ? t('multiplayerPanel.typing') : p.role === 'host' ? t('multiplayerPanel.roleHost') : t('multiplayerPanel.rolePeer')}
                </div>
              </div>
              {isHost && p.role !== 'host' && (
                <div style={{ display: 'flex', gap: 4 }}>
                  {turnStrategy === 'round_robin' && (
                    <>
                      <button style={iconBtn} title={t('multiplayerPanel.promoteTitle')} onClick={() => multiplayerApi.promote(roomId, p.id).catch(() => {})}>
                        <UserCheck size={14} />
                      </button>
                      <button style={iconBtn} title={t('multiplayerPanel.skipTitle')} onClick={() => multiplayerApi.skip(roomId, p.id).catch(() => {})}>
                        <SkipForward size={14} />
                      </button>
                    </>
                  )}
                  <button style={iconBtn} title={t('multiplayerPanel.kickTitle')} onClick={() => multiplayerApi.kick(roomId, p.id).catch(() => {})}>
                    <UserX size={14} />
                  </button>
                  <button
                    style={{ ...iconBtn, color: 'var(--lumiverse-danger, #ef4444)' }}
                    title={t('multiplayerPanel.banTitle')}
                    onClick={() => multiplayerApi.ban(roomId, p.id).catch(() => {})}
                  >
                    <Ban size={14} />
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
