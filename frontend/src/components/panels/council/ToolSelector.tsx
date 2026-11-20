import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { CouncilToolDefinition, CouncilToolCategory } from 'lumiverse-spindle-types'
import { Toggle } from '@/components/shared/Toggle'
import styles from '../CouncilManager.module.css'

interface ToolSelectorProps {
  tools: CouncilToolDefinition[]
  selected: string[]
  onChange: (selected: string[]) => void
}

const UNKNOWN_EXTENSION_KEY = '__unknown_extension__'

const BUILTIN_CATEGORY_ORDER: Exclude<CouncilToolCategory, 'extension'>[] = [
  'story_direction',
  'character_accuracy',
  'writing_quality',
  'context',
  'content',
]

export default function ToolSelector({ tools, selected, onChange }: ToolSelectorProps) {
  const { t } = useTranslation('panels', { keyPrefix: 'councilManager.tools' })

  const { builtinGroups, extensionGroups } = useMemo(() => {
    // Group built-in/DLC tools by category
    const builtin = new Map<string, CouncilToolDefinition[]>()
    for (const cat of BUILTIN_CATEGORY_ORDER) {
      builtin.set(cat, [])
    }

    // Group extension tools by extension name
    const extensions = new Map<string, CouncilToolDefinition[]>()

    for (const tool of tools) {
      if (tool.category === 'extension') {
        const extName = tool.extensionName || UNKNOWN_EXTENSION_KEY
        const list = extensions.get(extName) || []
        list.push(tool)
        extensions.set(extName, list)
      } else {
        const list = builtin.get(tool.category) || []
        list.push(tool)
        builtin.set(tool.category, list)
      }
    }

    return { builtinGroups: builtin, extensionGroups: extensions }
  }, [tools])

  const toggle = (name: string) => {
    if (selected.includes(name)) {
      onChange(selected.filter((n) => n !== name))
    } else {
      onChange([...selected, name])
    }
  }

  const sortedExtNames = Array.from(extensionGroups.keys()).sort()

  return (
    <div className={styles.toolSelector}>
      {/* Built-in & DLC tools by category */}
      {BUILTIN_CATEGORY_ORDER.map((cat) => {
        const catTools = builtinGroups.get(cat) || []
        if (catTools.length === 0) return null
        return (
          <div key={cat} className={styles.toolCategory}>
            <div className={styles.toolCategoryLabel}>{t(`toolCategories.${cat}`)}</div>
            {catTools.map((tool) => (
              <div key={tool.name} title={tool.description}>
                <Toggle.Checkbox
                  checked={selected.includes(tool.name)}
                  onChange={() => toggle(tool.name)}
                  label={tool.displayName}
                  className={styles.toolCheckbox}
                />
              </div>
            ))}
          </div>
        )
      })}

      {/* Extension tools grouped by extension name */}
      {sortedExtNames.map((extName) => {
        const extTools = extensionGroups.get(extName) || []
        return (
          <div key={`ext:${extName}`} className={styles.toolCategory}>
            <div className={styles.toolCategoryLabelExt}>
              {extName === UNKNOWN_EXTENSION_KEY ? t('unknownExtension') : extName}
              <span className={styles.toolExtBadge}>{t('extensionBadge')}</span>
            </div>
            {extTools.map((tool) => (
              <div key={tool.name} title={tool.description}>
                <Toggle.Checkbox
                  checked={selected.includes(tool.name)}
                  onChange={() => toggle(tool.name)}
                  label={tool.displayName}
                  className={styles.toolCheckbox}
                />
              </div>
            ))}
          </div>
        )
      })}
    </div>
  )
}
