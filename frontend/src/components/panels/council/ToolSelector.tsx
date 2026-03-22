import { useMemo } from 'react'
import type { CouncilToolDefinition, CouncilToolCategory } from 'lumiverse-spindle-types'
import styles from '../CouncilManager.module.css'

interface ToolSelectorProps {
  tools: CouncilToolDefinition[]
  selected: string[]
  onChange: (selected: string[]) => void
}

const CATEGORY_LABELS: Record<Exclude<CouncilToolCategory, 'extension'>, string> = {
  story_direction: 'Story Direction',
  character_accuracy: 'Character Accuracy',
  writing_quality: 'Writing Quality',
  context: 'Context',
  content: 'Content',
}

const BUILTIN_CATEGORY_ORDER: Exclude<CouncilToolCategory, 'extension'>[] = [
  'story_direction',
  'character_accuracy',
  'writing_quality',
  'context',
  'content',
]

export default function ToolSelector({ tools, selected, onChange }: ToolSelectorProps) {
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
        const extName = tool.extensionName || 'Unknown Extension'
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
            <div className={styles.toolCategoryLabel}>{CATEGORY_LABELS[cat]}</div>
            {catTools.map((tool) => (
              <label key={tool.name} className={styles.toolCheckbox} title={tool.description}>
                <input
                  type="checkbox"
                  checked={selected.includes(tool.name)}
                  onChange={() => toggle(tool.name)}
                />
                <span className={styles.toolCheckboxLabel}>{tool.displayName}</span>
              </label>
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
              {extName}
              <span className={styles.toolExtBadge}>Extension</span>
            </div>
            {extTools.map((tool) => (
              <label key={tool.name} className={styles.toolCheckbox} title={tool.description}>
                <input
                  type="checkbox"
                  checked={selected.includes(tool.name)}
                  onChange={() => toggle(tool.name)}
                />
                <span className={styles.toolCheckboxLabel}>{tool.displayName}</span>
              </label>
            ))}
          </div>
        )
      })}
    </div>
  )
}
