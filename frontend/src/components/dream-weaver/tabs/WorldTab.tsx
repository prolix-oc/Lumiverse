import { Globe, Sparkles, RefreshCw } from 'lucide-react'
import { generateUUID } from '@/lib/uuid'
import { Button } from '@/components/shared/FormComponents'
import { Spinner } from '@/components/shared/Spinner'
import { StickySection } from '../components/StickySection'
import { CollapsibleGroup } from '../components/CollapsibleGroup'
import type { DreamWeaverDraft, ExtendTarget } from '../../../api/dream-weaver'
import type { SectionStatus } from '../hooks/useDreamWeaverStudio'
import { hasWorldContent } from '../lib/studio-model'
import styles from './WorldTab.module.css'

interface WorldTabProps {
  draft: DreamWeaverDraft | null
  generatingWorld: boolean
  extending: Record<string, boolean>
  worldStale: boolean
  characterId: string | null
  syncingWorld: boolean
  worldSynced: boolean
  onSyncWorld: () => Promise<void>
  onUpdateLorebooks: (lorebooks: DreamWeaverDraft['lorebooks']) => void
  onUpdateNpcs: (npcs: DreamWeaverDraft['npc_definitions']) => void
  onUpdateRegexScripts: (scripts: DreamWeaverDraft['regex_scripts']) => void
  onGenerateWorld: () => Promise<void>
  onExtend: (target: ExtendTarget, instruction?: string, bookId?: string) => Promise<void>
  getSectionStatus: (section: string) => SectionStatus
}

export function WorldTab({
  draft,
  generatingWorld,
  extending,
  worldStale,
  characterId,
  syncingWorld,
  worldSynced,
  onSyncWorld,
  onUpdateLorebooks,
  onUpdateNpcs,
  onUpdateRegexScripts,
  onGenerateWorld,
  onExtend,
  getSectionStatus,
}: WorldTabProps) {
  if (!draft) {
    return (
      <div className={styles.emptyState}>
        <p>Generate a Soul draft first, then generate the World layer.</p>
      </div>
    )
  }

  if (!hasWorldContent(draft)) {
    return (
      <div className={styles.emptyState}>
        <Globe size={40} className={styles.emptyIcon} />
        <h3 className={styles.emptyTitle}>World Layer</h3>
        <p className={styles.emptyDescription}>
          World stays empty until lorebooks or NPCs exist. Generate that layer when you are ready to add setting structure.
        </p>
        <Button
          variant="primary"
          onClick={onGenerateWorld}
          loading={generatingWorld}
          disabled={generatingWorld}
          icon={<Sparkles size={16} />}
        >
          Generate World
        </Button>
      </div>
    )
  }

  const extendingLorebooks = extending.lorebook_entries ?? false
  const extendingNpcs = extending.npc_definitions ?? false
  const showSyncBanner = Boolean(characterId) && hasWorldContent(draft) && !worldSynced

  return (
    <div className={styles.worldTab}>
      {worldStale && (
        <div className={styles.warningBanner}>
          <div>
            <strong>World data may be out of sync.</strong>
            <p>Soul changed after the last world build. Review the lorebooks and NPCs, or rebuild the World layer from the current Soul draft.</p>
          </div>
          <Button
            variant="ghost"
            onClick={onGenerateWorld}
            loading={generatingWorld}
            disabled={generatingWorld}
          >
            Rebuild World
          </Button>
        </div>
      )}
      {showSyncBanner && (
        <div className={styles.syncBanner}>
          <div>
            <strong>Push world content to your character</strong>
            <p>Sync worldbooks, NPCs, and regex scripts to the finalized character so they are active in chat.</p>
          </div>
          <Button
            variant="ghost"
            onClick={onSyncWorld}
            loading={syncingWorld}
            disabled={syncingWorld}
            icon={<RefreshCw size={13} />}
          >
            Sync to Character
          </Button>
        </div>
      )}
      <StickySection
        id="lorebooks"
        label="World Books"
        status={getSectionStatus('lorebooks')}
        color="var(--lumiverse-primary, #bd9dff)"
      >
        {draft.lorebooks.map((book: any, bookIdx: number) => (
          <CollapsibleGroup
            key={book.id || bookIdx}
            label={book.name || `World Book ${bookIdx + 1}`}
            subtitle={`${book.entries?.length ?? 0} entries`}
            defaultOpen={bookIdx === 0}
            onDelete={() => {
              const updated = draft.lorebooks.filter((_: any, i: number) => i !== bookIdx)
              onUpdateLorebooks(updated)
            }}
          >
            {(book.entries || []).map((entry: any, entryIdx: number) => (
              <div key={entry.id || entryIdx} className={styles.entry}>
                <div className={styles.entryKeywords}>
                  <input
                    className={styles.input}
                    type="text"
                    value={Array.isArray(entry.keywords) ? entry.keywords.join(', ') : entry.keywords || ''}
                    onChange={(e) => {
                      const newBooks = [...draft.lorebooks]
                      const newEntries = [...(newBooks[bookIdx].entries || [])]
                      newEntries[entryIdx] = { ...newEntries[entryIdx], keywords: e.target.value.split(',').map((k: string) => k.trim()).filter(Boolean) }
                      newBooks[bookIdx] = { ...newBooks[bookIdx], entries: newEntries }
                      onUpdateLorebooks(newBooks)
                    }}
                    placeholder="Keywords (comma-separated)"
                  />
                </div>
                <textarea
                  className={styles.entryContent}
                  value={entry.content || ''}
                  onChange={(e) => {
                    const newBooks = [...draft.lorebooks]
                    const newEntries = [...(newBooks[bookIdx].entries || [])]
                    newEntries[entryIdx] = { ...newEntries[entryIdx], content: e.target.value }
                    newBooks[bookIdx] = { ...newBooks[bookIdx], entries: newEntries }
                    onUpdateLorebooks(newBooks)
                  }}
                  placeholder="Entry content..."
                  rows={3}
                />
                <button
                  className={styles.deleteEntry}
                  onClick={() => {
                    const newBooks = [...draft.lorebooks]
                    newBooks[bookIdx] = { ...newBooks[bookIdx], entries: (newBooks[bookIdx].entries || []).filter((_: any, i: number) => i !== entryIdx) }
                    onUpdateLorebooks(newBooks)
                  }}
                >&times;</button>
              </div>
            ))}
            <div className={styles.buttonRow}>
              <button
                className={styles.addButton}
                onClick={() => {
                  const newBooks = [...draft.lorebooks]
                  newBooks[bookIdx] = { ...newBooks[bookIdx], entries: [...(newBooks[bookIdx].entries || []), { id: generateUUID(), keywords: [], content: '' }] }
                  onUpdateLorebooks(newBooks)
                }}
              >+ Add Entry</button>
              <button
                className={styles.generateButton}
                disabled={!!extending[`lorebook_entries:${book.id}`]}
                onClick={() => onExtend('lorebook_entries', undefined, book.id)}
              >
                {extending[`lorebook_entries:${book.id}`] ? <Spinner size={11} /> : <Sparkles size={11} />}
                Generate Entries
              </button>
            </div>
          </CollapsibleGroup>
        ))}
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => {
              onUpdateLorebooks([...draft.lorebooks, { id: generateUUID(), name: 'New World Book', entries: [] }])
            }}
          >+ Add World Book</button>
          <button
            className={styles.generateButton}
            disabled={extendingLorebooks}
            onClick={() => onExtend('lorebook_entries')}
          >
            {extendingLorebooks ? <Spinner size={11} /> : <Sparkles size={11} />}
            Generate
          </button>
        </div>
      </StickySection>

      <StickySection
        id="npc_definitions"
        label="NPC Definitions"
        status={getSectionStatus('npc_definitions')}
        color="#c990fb"
      >
        {draft.npc_definitions.map((npc: any, idx: number) => (
          <CollapsibleGroup
            key={npc.id || idx}
            label={npc.name || `NPC ${idx + 1}`}
            subtitle={npc.role || ''}
            badge={(
              <span className={styles.importanceBadge} data-importance={npc.importance || 'minor'}>
                {npc.importance || 'minor'}
              </span>
            )}
            onDelete={() => onUpdateNpcs(draft.npc_definitions.filter((_: any, i: number) => i !== idx))}
          >
            <div className={styles.npcFields}>
              <input className={styles.input} placeholder="Name" value={npc.name || ''} onChange={(e) => { const u = [...draft.npc_definitions]; u[idx] = { ...u[idx], name: e.target.value }; onUpdateNpcs(u) }} />
              <input className={styles.input} placeholder="Role" value={npc.role || ''} onChange={(e) => { const u = [...draft.npc_definitions]; u[idx] = { ...u[idx], role: e.target.value }; onUpdateNpcs(u) }} />
              <textarea className={styles.entryContent} placeholder="Description" value={npc.description || ''} rows={3} onChange={(e) => { const u = [...draft.npc_definitions]; u[idx] = { ...u[idx], description: e.target.value }; onUpdateNpcs(u) }} />
              <textarea className={styles.entryContent} placeholder="Personality" value={npc.personality || ''} rows={2} onChange={(e) => { const u = [...draft.npc_definitions]; u[idx] = { ...u[idx], personality: e.target.value }; onUpdateNpcs(u) }} />
              <textarea className={styles.entryContent} placeholder="Relationship to main character" value={npc.relationship_to_card || ''} rows={2} onChange={(e) => { const u = [...draft.npc_definitions]; u[idx] = { ...u[idx], relationship_to_card: e.target.value }; onUpdateNpcs(u) }} />
              <input className={styles.input} placeholder="Keyword triggers (comma-separated)" value={Array.isArray(npc.keyword_triggers) ? npc.keyword_triggers.join(', ') : ''} onChange={(e) => { const u = [...draft.npc_definitions]; u[idx] = { ...u[idx], keyword_triggers: e.target.value.split(',').map((k: string) => k.trim()).filter(Boolean) }; onUpdateNpcs(u) }} />
            </div>
          </CollapsibleGroup>
        ))}
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => onUpdateNpcs([...draft.npc_definitions, { id: generateUUID(), name: '', role: '', description: '', personality: '', relationship_to_card: '', keyword_triggers: [], importance: 'minor' }])}
          >+ Add NPC</button>
          <button
            className={styles.generateButton}
            disabled={extendingNpcs}
            onClick={() => onExtend('npc_definitions')}
          >
            {extendingNpcs ? <Spinner size={11} /> : <Sparkles size={11} />}
            Generate
          </button>
        </div>
      </StickySection>

      <StickySection
        id="regex_scripts"
        label="Regex Scripts"
        status={getSectionStatus('regex_scripts')}
        color="#6ec6ff"
      >
        {(draft.regex_scripts || []).map((script: any, idx: number) => (
          <CollapsibleGroup
            key={script.id || idx}
            label={script.name || `Script ${idx + 1}`}
            subtitle={script.description || ''}
            onDelete={() => onUpdateRegexScripts(draft.regex_scripts.filter((_: any, i: number) => i !== idx))}
          >
            <div className={styles.npcFields}>
              <input className={styles.input} placeholder="Name" value={script.name || ''} onChange={(e) => { const u = [...draft.regex_scripts]; u[idx] = { ...u[idx], name: e.target.value }; onUpdateRegexScripts(u) }} />
              <input className={styles.input} placeholder="Description" value={script.description || ''} onChange={(e) => { const u = [...draft.regex_scripts]; u[idx] = { ...u[idx], description: e.target.value }; onUpdateRegexScripts(u) }} />
              <div className={styles.regexRow}>
                <input className={styles.input} placeholder="Find (regex pattern)" value={script.find_regex || ''} onChange={(e) => { const u = [...draft.regex_scripts]; u[idx] = { ...u[idx], find_regex: e.target.value }; onUpdateRegexScripts(u) }} />
                <input className={`${styles.input} ${styles.regexFlags}`} placeholder="Flags" value={script.flags || 'gi'} onChange={(e) => { const u = [...draft.regex_scripts]; u[idx] = { ...u[idx], flags: e.target.value }; onUpdateRegexScripts(u) }} />
              </div>
              <input className={styles.input} placeholder="Replace with" value={script.replace_string || ''} onChange={(e) => { const u = [...draft.regex_scripts]; u[idx] = { ...u[idx], replace_string: e.target.value }; onUpdateRegexScripts(u) }} />
              <select className={styles.input} value={script.target || 'response'} onChange={(e) => { const u = [...draft.regex_scripts]; u[idx] = { ...u[idx], target: e.target.value }; onUpdateRegexScripts(u) }}>
                <option value="response">Target: AI Response</option>
                <option value="prompt">Target: User Prompt</option>
                <option value="display">Target: Display Only</option>
              </select>
            </div>
          </CollapsibleGroup>
        ))}
        <div className={styles.buttonRow}>
          <button
            className={styles.addButton}
            onClick={() => onUpdateRegexScripts([...(draft.regex_scripts || []), { id: generateUUID(), name: '', description: '', find_regex: '', replace_string: '', flags: 'gi', target: 'response' }])}
          >+ Add Script</button>
        </div>
      </StickySection>
    </div>
  )
}
