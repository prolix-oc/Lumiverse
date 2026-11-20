import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { GitBranch, MessageCircle, Info, Scissors } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import type { ChatTreeNode } from '@/types/api'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import { formatRelativeTime } from '@/lib/formatRelativeTime'
import styles from './BranchTreePanel.module.css'

function treeSize(node: ChatTreeNode): number {
  return 1 + node.children.reduce((acc, c) => acc + treeSize(c), 0)
}

// Pixels added per real branch level — mirrors .children's margin-left + padding-left.
const INDENT_STEP = 29
// Keep the deepest node card at least this wide. maxIndent is derived from the
// panel's measured width (users can resize the drawer) so cards stay readable.
const MIN_CARD_WIDTH = 190

interface NodeProps {
  node: ChatTreeNode
  currentChatId: string
  indent: number
  maxIndent: number
}

function Node({ node, currentChatId, indent, maxIndent }: NodeProps) {
  const navigate = useNavigate()
  const closeDrawer = useStore((s) => s.closeDrawer)
  const { t } = useTranslation('panels')
  const isCurrent = node.id === currentChatId

  function handleClick() {
    if (!isCurrent) {
      navigate(`/chat/${node.id}`)
      closeDrawer()
    }
  }

  // Indentation steps in only at a real branch point (2+ children) and only while
  // the measured width budget allows it. Linear fork chains (a single child) and
  // any depth past the budget render flush, so they never staircase off-screen.
  const stepsIn = node.children.length > 1 && indent < maxIndent
  const childIndent = stepsIn ? indent + 1 : indent

  return (
    <div className={styles.treeItem}>
      <button
        type="button"
        className={clsx(styles.node, isCurrent && styles.nodeCurrent)}
        onClick={handleClick}
        disabled={isCurrent}
        title={isCurrent ? t('branchTree.currentChat') : t('branchTree.openChatTitle', { name: node.name })}
      >
        <div className={styles.nodeIcon}>
          {isCurrent
            ? <MessageCircle size={13} strokeWidth={2} />
            : <GitBranch size={13} strokeWidth={2} />
          }
        </div>
        <div className={styles.nodeBody}>
          <span className={styles.nodeName}>
            {node.name || t('branchTree.untitledChat')}
          </span>
          <span className={styles.nodeMeta}>
            {t('branchTree.messageCount', { count: node.message_count })}
            {' · '}
            {formatRelativeTime(node.updated_at)}
          </span>
          {node.branch_message_preview && (
            <span className={styles.branchPreview} title={node.branch_message_preview}>
              <Scissors size={10} strokeWidth={2} />
              <span>
                {node.branch_message_index !== null && `#${node.branch_message_index} · `}
                {node.branch_message_preview}
              </span>
            </span>
          )}
        </div>
        {isCurrent && (
          <span className={styles.nodeCurrentBadge}>{t('branchTree.here')}</span>
        )}
      </button>

      {node.children.length > 0 && (
        <div className={clsx(styles.children, !stepsIn && styles.childrenFlush)}>
          {node.children.map((child) => (
            <Node
              key={child.id}
              node={child}
              currentChatId={currentChatId}
              indent={childIndent}
              maxIndent={maxIndent}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function BranchTreePanel() {
  const { t } = useTranslation('panels')
  const activeChatId = useStore((s) => s.activeChatId)
  const [tree, setTree] = useState<ChatTreeNode | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const [maxIndent, setMaxIndent] = useState(6)

  useEffect(() => {
    if (!activeChatId) return
    setLoading(true)
    setError(false)
    chatsApi.getTree(activeChatId)
      .then(setTree)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [activeChatId])

  // Derive how many indent levels fit from the panel's real width (resizable),
  // keeping the deepest card at least MIN_CARD_WIDTH. Re-runs when the tree mounts
  // (so rootRef is attached) and whenever the drawer is resized.
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const update = () => {
      const width = el.clientWidth
      if (width <= 0) return
      const fits = Math.floor((width - MIN_CARD_WIDTH) / INDENT_STEP)
      setMaxIndent(Math.max(1, Math.min(12, fits)))
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [tree])

  if (!activeChatId) {
    return (
      <div className={styles.center}>
        <GitBranch size={32} strokeWidth={1.5} />
        <p className={styles.centerTitle}>{t('branchTree.noChatOpen')}</p>
        <p className={styles.centerHint}>{t('branchTree.openChatHint')}</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.center}>
        <p className={styles.centerHint}>{t('branchTree.loading')}</p>
      </div>
    )
  }

  if (error || !tree) {
    return (
      <div className={styles.center}>
        <GitBranch size={32} strokeWidth={1.5} />
        <p className={styles.centerTitle}>{t('branchTree.loadError')}</p>
      </div>
    )
  }

  const total = treeSize(tree)
  const isAlone = total === 1

  if (isAlone) {
    return (
      <div className={styles.panel}>
        <div className={styles.center}>
          <GitBranch size={32} strokeWidth={1.5} />
          <p className={styles.centerTitle}>{t('branchTree.noBranches')}</p>
          <p className={styles.centerHint}>
            {t('branchTree.noBranchesHintPrefix')}{' '}
            <GitBranch size={11} strokeWidth={2} style={{ display: 'inline', verticalAlign: 'middle' }} />{' '}
            {t('branchTree.noBranchesHintSuffix')}
          </p>
        </div>
      </div>
    )
  }

  return (
    <PanelFadeIn>
      <div className={styles.panel}>
        <div className={styles.root} ref={rootRef}>
          <Node node={tree} currentChatId={activeChatId} indent={0} maxIndent={maxIndent} />
        </div>

        <div className={styles.hint}>
          <Info size={13} strokeWidth={1.5} />
          <span>
            {t('branchTree.footerHintPrefix')}{' '}
            <GitBranch size={11} strokeWidth={2} style={{ display: 'inline', verticalAlign: 'middle' }} />{' '}
            {t('branchTree.footerHintSuffix')}
          </span>
        </div>
      </div>
    </PanelFadeIn>
  )
}
