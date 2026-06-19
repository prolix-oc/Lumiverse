import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import * as weaverApi from '@/api/weaver'
import type { WeaverHubSummary, WeaverPerson, WeaverSession } from '@/api/weaver'
import { Band, Btn, Icon, IconBtn, KindChip, Tile } from '../primitives'
import { PersonWeave } from './PersonWeave'
import styles from '../WeaverStudio.module.css'

function peopleErrMsg(err: unknown, fallback: string): string {
  const body = (err as { body?: { error?: string } } | null)?.body
  return body?.error ?? (err instanceof Error ? err.message : fallback)
}

export function PeoplePane({ session, onCount }: { session: WeaverSession; onCount?: (n: number) => void }) {
  const { t } = useTranslation('weaver')
  const openModal = useStore((s) => s.openModal)
  const openSession = useStore((s) => s.openWeaverSession)
  const loadSessions = useStore((s) => s.loadWeaverSessions)

  const [hub, setHub] = useState<WeaverHubSummary | null>(null)
  const [people, setPeople] = useState<WeaverPerson[]>([])
  const [error, setError] = useState<string | null>(null)
  const [proposing, setProposing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [hook, setHook] = useState('')
  const [busy, setBusy] = useState(false)
  const [fleshingId, setFleshingId] = useState<string | null>(null)
  const [weavingId, setWeavingId] = useState<string | null>(null)

  const npcBook = hub?.books.find((b) => b.role === 'npc') ?? null
  const questionTarget = hub?.people?.question_target ?? 3

  const refresh = useCallback(async () => {
    try {
      const [summary, res] = await Promise.all([
        weaverApi.getHub(session.id),
        weaverApi.getPeople(session.id),
      ])
      setHub(summary)
      setPeople(res.people)
      onCount?.(res.people.length)
    } catch (err) {
      setError(peopleErrMsg(err, t('hub.people.loadFailed')))
    }
  }, [session.id, t, onCount])
  useEffect(() => { void refresh() }, [refresh])

  const propose = async () => {
    if (proposing) return
    setProposing(true); setError(null)
    try {
      const res = await weaverApi.proposePeople(session.id)
      setPeople(res.people)
      onCount?.(res.people.length)
    } catch (err) {
      setError(peopleErrMsg(err, t('hub.people.proposeFailed')))
    } finally {
      setProposing(false)
    }
  }

  const add = async () => {
    if (!name.trim() || busy) return
    setBusy(true); setError(null)
    try {
      await weaverApi.addPerson(session.id, {
        name: name.trim(),
        ...(hook.trim() ? { hook: hook.trim() } : {}),
      })
      setName(''); setHook(''); setAdding(false)
      void refresh()
    } catch (err) {
      setError(peopleErrMsg(err, t('hub.people.addFailed')))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (person: WeaverPerson) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await weaverApi.removePerson(session.id, person.id)
      void refresh()
    } catch (err) {
      setError(peopleErrMsg(err, t('hub.people.removeFailed')))
    } finally {
      setBusy(false)
    }
  }

  const flesh = async (person: WeaverPerson) => {
    if (fleshingId) return
    setFleshingId(person.id); setError(null)
    try {
      await weaverApi.fleshExtra(session.id, person.id)
      void refresh()
    } catch (err) {
      setError(peopleErrMsg(err, t('hub.people.fleshFailed')))
    } finally {
      setFleshingId(null)
    }
  }

  const promote = async (person: WeaverPerson) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      const res = await weaverApi.promoteNamed(session.id, person.id)
      void loadSessions().then(() => openSession(res.session.id))
    } catch (err) {
      setError(peopleErrMsg(err, t('hub.people.promoteFailed')))
    } finally {
      setBusy(false)
    }
  }

  const weavingPerson = weavingId ? people.find((p) => p.id === weavingId) ?? null : null
  const rowsBusy = busy || fleshingId !== null || weavingId !== null
  const characters = hub?.characters ?? []
  const promotions = hub?.promotions ?? []
  const universeCount = characters.length + promotions.length

  return (
    <div className={styles.dashPaneInner}>
      <div className={styles.cardPaneHead}>
        <span className={styles.cardPaneTitle}>{t('hub.people.paneTitle')}</span>
        <span className={styles.cardPaneCount}>
          {t('hub.people.paneCounts', { universe: universeCount, roster: people.length })}
        </span>
        <div className={styles.spacer} />
        {!weavingPerson && (
          <Btn className={styles.btnTiny} icon="sparkles" spin={proposing} disabled={proposing || rowsBusy} onClick={() => void propose()}>
            {t('hub.people.propose')}
          </Btn>
        )}
      </div>

      {error && <p className={styles.errorText}>{error}</p>}

      {weavingPerson ? (
        <PersonWeave
          session={session}
          person={weavingPerson}
          questionTarget={questionTarget}
          onWoven={() => { setWeavingId(null); void refresh() }}
          onClose={() => { setWeavingId(null); void refresh() }}
        />
      ) : (
        <>
          <Band label={t('hub.people.inUniverseBand')} hint={t('hub.people.inUniverseHint')}>
            {universeCount === 0 ? (
              <p className={styles.stageHelp}>{t('hub.people.inUniverseEmpty')}</p>
            ) : (
              <div className={styles.loreList}>
                {characters.map((ch) => (
                  <div key={ch.id} className={styles.ppRow}>
                    <Tile name={ch.name} size={24} />
                    <span className={styles.ppMain}>
                      <span className={styles.ppName}>{ch.name}</span>
                      <span className={styles.ppLine}>{t('hub.inUniverseLine')}</span>
                    </span>
                    <KindChip>{t('hub.cardChip')}</KindChip>
                    <span />
                  </div>
                ))}
                {promotions.map((p) => (
                  <div key={p.person_id} className={styles.ppRow}>
                    <Tile name={p.name} size={24} />
                    <span className={styles.ppMain}>
                      <span className={styles.ppName}>{p.name}</span>
                      <span className={styles.ppLine}>{t('hub.promotionLine')}</span>
                    </span>
                    <KindChip>{t('hub.inLoomChip')}</KindChip>
                    <span className={styles.ppActions}>
                      <Btn className={styles.btnTiny} icon="arrowRight" onClick={() => openSession(p.session_id)}>{t('hub.openSession')}</Btn>
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Band>

          <Band label={t('hub.people.rosterBand')} hint={t('hub.people.rosterHint')}>
            {people.length === 0 ? (
              <p className={styles.stageHelp}>{t('hub.people.empty')}</p>
            ) : (
              <div className={styles.loreList}>
                {people.map((p) => (
                  <div key={p.id} className={styles.ppRow}>
                    <Tile name={p.name} size={24} empty={p.tier === 'unfleshed'} />
                    <span className={styles.ppMain}>
                      <span className={styles.ppName}>{p.name}</span>
                      {p.hook && <span className={styles.ppLine} title={p.hook}>{p.hook}</span>}
                    </span>
                    <span className={styles.ppChips}>
                      {p.origin === 'interview' && (
                        <KindChip title={t('hub.people.interviewChipTitle')}>{t('hub.people.interviewChip')}</KindChip>
                      )}
                      <KindChip title={t(`hub.people.tierTitle.${p.tier}`)}>{t(`hub.people.tier.${p.tier}`)}</KindChip>
                    </span>
                    <span className={styles.ppActions}>
                      {p.tier === 'unfleshed' && (
                        <>
                          <Btn
                            className={styles.btnTiny}
                            icon="user"
                            spin={fleshingId === p.id}
                            disabled={rowsBusy}
                            title={t('hub.people.extraTitle')}
                            onClick={() => void flesh(p)}
                          >
                            {t('hub.people.extra')}
                          </Btn>
                          <Btn className={styles.btnTiny} icon="penLine" disabled={rowsBusy} title={t('hub.people.weaveTitle')} onClick={() => setWeavingId(p.id)}>
                            {t('hub.people.named')}
                          </Btn>
                          <IconBtn icon="trash" title={t('hub.people.remove')} disabled={rowsBusy} onClick={() => void remove(p)} />
                        </>
                      )}
                      {p.tier === 'extra' && (
                        <Btn className={styles.btnTiny} icon="penLine" disabled={rowsBusy} title={t('hub.people.weaveTitle')} onClick={() => setWeavingId(p.id)}>
                          {t('hub.people.weaveNamed')}
                        </Btn>
                      )}
                      {p.tier === 'named' && (
                        <>
                          <Btn className={styles.btnTiny} icon="penLine" disabled={rowsBusy} title={t('hub.people.reweaveTitle')} onClick={() => setWeavingId(p.id)}>
                            {t('hub.people.weave')}
                          </Btn>
                          <Btn className={styles.btnTiny} icon="arrowRight" disabled={rowsBusy} title={t('hub.people.promoteTitle')} onClick={() => void promote(p)}>
                            {p.promoted_session_id ? t('hub.people.promotion') : t('hub.people.promote')}
                          </Btn>
                        </>
                      )}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <div className={styles.toolRow}>
              {!adding ? (
                <Btn className={styles.btnTiny} icon="plus" disabled={proposing} onClick={() => setAdding(true)}>
                  {t('hub.people.addPerson')}
                </Btn>
              ) : (
                <>
                  <input
                    className={styles.toolin}
                    value={name}
                    placeholder={t('hub.people.namePlaceholder')}
                    maxLength={120}
                    autoFocus
                    onChange={(e) => setName(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
                  />
                  <input
                    className={styles.toolin}
                    value={hook}
                    placeholder={t('hub.people.hookPlaceholder')}
                    maxLength={240}
                    onChange={(e) => setHook(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') void add() }}
                  />
                  <Btn variant="primary" icon="check" spin={busy} disabled={!name.trim() || busy} onClick={() => void add()}>
                    {t('hub.people.add')}
                  </Btn>
                  <IconBtn icon="x" title={t('hub.people.cancel')} disabled={busy} onClick={() => { setAdding(false); setName(''); setHook('') }} />
                </>
              )}
              <div className={styles.spacer} />
              {npcBook && (
                <>
                  <Icon name="bookOpen" size={15} />
                  <span className={styles.cardPaneCount}>{npcBook.name} · {t('hub.entryCount', { count: npcBook.entry_count })}</span>
                  <Btn className={styles.btnTiny} icon="pencil" onClick={() => openModal('worldBookEditor', { bookId: npcBook.id })}>{t('hub.openBook')}</Btn>
                </>
              )}
            </div>
          </Band>
        </>
      )}
    </div>
  )
}
