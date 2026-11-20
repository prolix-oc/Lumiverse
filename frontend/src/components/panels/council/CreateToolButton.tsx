import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import styles from '../CouncilManager.module.css'

/** Use the member's custom pack, or Workshop's first custom pack/default. */
export default function CreateToolButton({ packId }: { packId?: string }) {
  const { t } = useTranslation('panels')
  const [busy, setBusy] = useState(false)
  const create = async () => {
    setBusy(true)
    try {
      const state = useStore.getState()
      const packs = await packsApi.list({ limit: 100 })
      state.setPacks(packs.data)
      const custom = packs.data.filter((pack) => pack.is_custom)
      let pack = custom.find((pack) => pack.id === packId) ?? custom[0]
      if (!pack) {
        pack = await packsApi.create({ name: t('creatorWorkshop.workshop.myPackDefault'), is_custom: true })
        state.addPack(pack)
      }
      const targetId = pack.id
      state.openModal('toolEditor', { packId: targetId, onSaved: async () => {
        const updated = await packsApi.get(targetId)
        useStore.getState().setPackWithItems(targetId, updated)
      } })
    } catch (error) {
      useStore.getState().addToast({ type: 'error', message: error instanceof Error ? error.message : String(error) })
    } finally { setBusy(false) }
  }
  return <button type="button" className={styles.assignToolsBtn} disabled={busy} onClick={create}>{t('councilWorkspace.createTool', { defaultValue: '+ Create tool' })}</button>
}
