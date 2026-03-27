import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import { GitBranch, MessageCircle, Info, Scissors } from 'lucide-react'
import clsx from 'clsx'
import { chatsApi } from '@/api/chats'
import { useStore } from '@/store'
import type { ChatTreeNode } from '@/types/api'
import PanelFadeIn from '@/components/shared/PanelFadeIn'
import styles from './BranchTreePanel.module.css'

function relativeTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d ago`
  return new Date(unixSeconds * 1000).toLocaleDateString()
}

function treeSize(node: ChatTreeNode): number {
  return 1 + node.children.reduce((acc, c) => acc + treeSize(c), 0)
}

interface NodeProps {
  node: ChatTreeNode
  currentChatId: string
}

function Node({ node, currentChatId }: NodeProps) {
  const navigate = useNavigate()
  const closeDrawer = useStore((s) => s.closeDrawer)
  const isCurrent = node.id === currentChatId

  function handleClick() {
    if (!isCurrent) {
      navigate(`/chat/${node.id}`)
      closeDrawer()
    }
  }

  return (
    <div className={styles.treeItem}>
      <button
        type="button"
        className={clsx(styles.node, isCurrent && styles.nodeCurrent)}
        onClick={handleClick}
        disabled={isCurrent}
        title={isCurrent ? 'Current chat' : `Open "${node.name}"`}
      >
        <div className={styles.nodeIcon}>
          {isCurrent
            ? <MessageCircle size={13} strokeWidth={2} />
            : <GitBranch size={13} strokeWidth={2} />
          }
        </div>
        <div className={styles.nodeBody}>
          <span className={styles.nodeName}>
            {node.name || 'Untitled Chat'}
          </span>
          <span className={styles.nodeMeta}>
            {node.message_count} {node.message_count === 1 ? 'message' : 'messages'}
            {' · '}
            {relativeTime(node.updated_at)}
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
          <span className={styles.nodeCurrentBadge}>here</span>
        )}
      </button>

      {node.children.length > 0 && (
        <div className={styles.children}>
          {node.children.map((child) => (
            <Node
              key={child.id}
              node={child}
              currentChatId={currentChatId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export default function BranchTreePanel() {
  const activeChatId = useStore((s) => s.activeChatId)
  const [tree, setTree] = useState<ChatTreeNode | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!activeChatId) return
    setLoading(true)
    setError(false)
    chatsApi.getTree(activeChatId)
      .then(setTree)
      .catch(() => setError(true))
      .finally(() => setLoading(false))
  }, [activeChatId])

  if (!activeChatId) {
    return (
      <div className={styles.center}>
        <GitBranch size={32} strokeWidth={1.5} />
        <p className={styles.centerTitle}>No chat open</p>
        <p className={styles.centerHint}>Open a chat to see its branch history.</p>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={styles.center}>
        <p className={styles.centerHint}>Loading…</p>
      </div>
    )
  }

  if (error || !tree) {
    return (
      <div className={styles.center}>
        <GitBranch size={32} strokeWidth={1.5} />
        <p className={styles.centerTitle}>Couldn't load tree</p>
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
          <p className={styles.centerTitle}>No branches yet</p>
          <p className={styles.centerHint}>
            Fork this chat at any message using the{' '}
            <GitBranch size={11} strokeWidth={2} style={{ display: 'inline', verticalAlign: 'middle' }} />{' '}
            icon to create branches you can explore independently.
          </p>
        </div>
      </div>
    )
  }

  return (
    <PanelFadeIn>
      <div className={styles.panel}>
        <div className={styles.root}>
          <Node node={tree} currentChatId={activeChatId} />
        </div>

        <div className={styles.hint}>
          <Info size={13} strokeWidth={1.5} />
          <span>
            Click any node to jump to that branch.
            Fork at a message using the <GitBranch size={11} strokeWidth={2} style={{ display: 'inline', verticalAlign: 'middle' }} /> icon in the message actions.
          </span>
        </div>
      </div>
    </PanelFadeIn>
  )
}
