import { useState, useMemo, useEffect } from 'react'
import { Pencil, Trash2, Wrench, ChevronDown, ChevronRight, Users2, X } from 'lucide-react'
import type { CouncilMember, CouncilToolDefinition } from 'lumiverse-spindle-types'
import type { PackWithItems } from '@/types/api'
import { useStore } from '@/store'
import { packsApi } from '@/api/packs'
import { FormField, TextInput } from '@/components/shared/FormComponents'
import NumberStepper from '@/components/shared/NumberStepper'
import LazyImage from '@/components/shared/LazyImage'
import ToolSelector from './ToolSelector'
import styles from '../CouncilManager.module.css'

interface CouncilMemberItemProps {
  member: CouncilMember
  availableTools: CouncilToolDefinition[]
  onUpdate: (id: string, updates: Partial<CouncilMember>) => void
  onDelete: () => void
}

export default function CouncilMemberItem({ member, availableTools, onUpdate, onDelete }: CouncilMemberItemProps) {
  const [expanded, setExpanded] = useState(false)
  const [showToolPicker, setShowToolPicker] = useState(false)
  const packsWithItems = useStore((s) => s.packsWithItems)
  const setPackWithItems = useStore((s) => s.setPackWithItems)

  // Ensure pack data is loaded so we can resolve the avatar
  const packData = packsWithItems[member.packId] as PackWithItems | undefined
  useEffect(() => {
    if (packData) return
    packsApi.get(member.packId).then((data) => {
      setPackWithItems(member.packId, data)
    }).catch(() => {})
  }, [member.packId, packData, setPackWithItems])

  const lumiaItem = packData?.lumia_items?.find((i) => i.id === member.itemId)
  const avatarUrl = lumiaItem?.avatar_url

  // Build tool display name map
  const toolMap = useMemo(() => {
    const map = new Map<string, CouncilToolDefinition>()
    for (const t of availableTools) map.set(t.name, t)
    return map
  }, [availableTools])

  const assignedTools = member.tools
    .map((name) => toolMap.get(name))
    .filter(Boolean) as CouncilToolDefinition[]

  return (
    <div className={styles.memberCard}>
      {/* Collapsed header row */}
      <div className={styles.memberHeader} role="button" tabIndex={0} onClick={() => setExpanded(!expanded)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded) } }}>
        <div className={styles.memberAvatar}>
          <LazyImage
            src={avatarUrl}
            alt=""
            spinnerSize={16}
            fallback={<Users2 size={18} />}
          />
        </div>
        <div className={styles.memberInfo}>
          <div className={styles.memberName}>{member.itemName}</div>
          <div className={styles.memberStats}>
            <span className={styles.statBadge} title="Tools assigned">
              <Wrench size={10} /> {member.tools.length}
            </span>
            <span className={styles.statBadge} title="Chance">
              {member.chance}%
            </span>
          </div>
        </div>
        <div className={styles.memberActions}>
          <button
            type="button"
            className={styles.actionBtnDanger}
            onClick={(e) => { e.stopPropagation(); onDelete() }}
            title="Remove"
          >
            <Trash2 size={13} />
          </button>
          <div className={styles.chevron}>
            {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          </div>
        </div>
      </div>

      {/* Expanded inline editor */}
      {expanded && (
        <div className={styles.memberBody}>
          {/* Role */}
          <div className={styles.inlineField}>
            <span className={styles.inlineLabel}>Role:</span>
            <span className={styles.inlineValue}>
              {member.role ? (
                <TextInput
                  value={member.role}
                  onChange={(val) => onUpdate(member.id, { role: val })}
                  placeholder="e.g. Plot Enforcer"
                />
              ) : (
                <TextInput
                  value=""
                  onChange={(val) => onUpdate(member.id, { role: val })}
                  placeholder="No role set"
                />
              )}
            </span>
          </div>

          {/* Chance */}
          <div className={styles.inlineField}>
            <span className={styles.inlineLabel}>% Chance:</span>
            <div className={styles.chanceRow}>
              <NumberStepper
                value={member.chance}
                onChange={(val) => onUpdate(member.id, { chance: val })}
                min={0}
                max={100}
                step={5}
              />
              <span className={styles.chanceHint}>Likelihood of contributing each generation</span>
            </div>
          </div>

          {/* Divider */}
          <div className={styles.memberDivider} />

          {/* Tools section */}
          <div className={styles.toolsSection}>
            <div className={styles.toolsSectionHeader}>
              <span className={styles.inlineLabel}>
                <Wrench size={12} /> Tools:
              </span>
              <button
                type="button"
                className={styles.assignToolsBtn}
                onClick={() => setShowToolPicker(!showToolPicker)}
              >
                {showToolPicker ? 'Done' : 'Assign Tools'}
              </button>
            </div>

            {/* Tool pills */}
            {assignedTools.length > 0 ? (
              <div className={styles.toolPills}>
                {assignedTools.map((tool) => (
                  <span key={tool.name} className={tool.category === 'extension' ? styles.toolPillExtension : styles.toolPill}>
                    {tool.displayName}
                    <button
                      type="button"
                      className={styles.toolPillRemove}
                      onClick={() => onUpdate(member.id, { tools: member.tools.filter((t) => t !== tool.name) })}
                    >
                      <X size={10} />
                    </button>
                  </span>
                ))}
              </div>
            ) : (
              <div className={styles.noTools}>No tools assigned</div>
            )}

            {/* Tool picker */}
            {showToolPicker && (
              <div className={styles.toolPickerInline}>
                <ToolSelector
                  tools={availableTools}
                  selected={member.tools}
                  onChange={(tools) => onUpdate(member.id, { tools })}
                />
              </div>
            )}
          </div>

          {/* Helper text */}
          <div className={styles.memberHelperText}>
            Each member's inherent traits are auto-attached when added. Use the role field to define their expertise, which enhances tool contributions.
          </div>
        </div>
      )}
    </div>
  )
}
