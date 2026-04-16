/**
 * Starter templates and props documentation for overridable components.
 *
 * Tier 1 components get a curated template with the flattened props contract.
 * Tier 2 components get a generic template with their raw props.
 */

export interface PropDoc {
  name: string
  type: string
  description: string
  children?: PropDoc[]
}

export interface ComponentTemplate {
  /** Starter TSX code shown when the editor is empty */
  template: string
  /** Documented props for the reference panel */
  props: PropDoc[]
}

// ── Tier 1: Curated props contracts ─────────────────────────────────

const BUBBLE_MESSAGE: ComponentTemplate = {
  template: `export default function BubbleMessage({ message, content, reasoning, swipes, attachments, editing, actions, styles, _raw }) {
  return (
    <div style={{ padding: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        {message.avatarUrl && (
          <img src={message.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: '50%' }} />
        )}
        <strong style={{ color: message.isUser ? '#a78bfa' : '#60a5fa' }}>
          {message.displayName}
        </strong>
        <span style={{ fontSize: 11, opacity: 0.5 }}>#{message.index}</span>
      </div>

      {/* Reasoning */}
      {reasoning && (
        <details style={{ marginBottom: 8, fontSize: 12, opacity: 0.7 }}>
          <summary>Thinking{reasoning.duration ? \` (\${reasoning.duration}ms)\` : ''}</summary>
          <pre style={{ whiteSpace: 'pre-wrap' }}>{reasoning.raw}</pre>
        </details>
      )}

      {/* Content */}
      <div dangerouslySetInnerHTML={{ __html: content.html || content.raw }} />

      {/* Swipes */}
      {swipes.total > 1 && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, fontSize: 12 }}>
          <button onClick={actions.swipeLeft}>←</button>
          <span>{swipes.current} / {swipes.total}</span>
          <button onClick={actions.swipeRight}>→</button>
        </div>
      )}

      {/* Actions */}
      <div style={{ display: 'flex', gap: 4, marginTop: 8, opacity: 0.6, fontSize: 11 }}>
        <button onClick={actions.copy}>Copy</button>
        <button onClick={actions.edit}>Edit</button>
        <button onClick={actions.fork}>Fork</button>
        <button onClick={actions.toggleHidden}>{message.isHidden ? 'Show' : 'Hide'}</button>
        <button onClick={actions.delete}>Delete</button>
      </div>
    </div>
  )
}`,
  props: [
    { name: 'message', type: 'object', description: 'Message identity and state', children: [
      { name: 'id', type: 'string', description: 'Message UUID' },
      { name: 'index', type: 'number', description: 'Position in chat (0-based)' },
      { name: 'sendDate', type: 'number', description: 'Unix timestamp' },
      { name: 'isUser', type: 'boolean', description: 'True if sent by user' },
      { name: 'displayName', type: 'string', description: 'Resolved display name' },
      { name: 'avatarUrl', type: 'string | null', description: 'Avatar image URL' },
      { name: 'isHidden', type: 'boolean', description: 'Hidden from AI context' },
      { name: 'isStreaming', type: 'boolean', description: 'Currently streaming tokens' },
      { name: 'isLastMessage', type: 'boolean', description: 'Last message in chat' },
      { name: 'tokenCount', type: 'number | null', description: 'Token count for this message' },
    ]},
    { name: 'content', type: 'object', description: 'Message text', children: [
      { name: 'raw', type: 'string', description: 'Raw markdown source' },
      { name: 'html', type: 'string', description: 'Pre-rendered HTML (markdown, code highlighting, macros applied)' },
    ]},
    { name: 'reasoning', type: 'object | null', description: 'CoT reasoning block (null if none)', children: [
      { name: 'raw', type: 'string', description: 'Raw reasoning text' },
      { name: 'duration', type: 'number | null', description: 'Thinking duration in ms' },
      { name: 'isStreaming', type: 'boolean', description: 'Reasoning still streaming' },
    ]},
    { name: 'swipes', type: 'object', description: 'Swipe/variant navigation', children: [
      { name: 'current', type: 'number', description: 'Current swipe (1-based)' },
      { name: 'total', type: 'number', description: 'Total swipe count' },
    ]},
    { name: 'attachments', type: 'array', description: 'Inline attachments', children: [
      { name: '[].type', type: '"image" | "audio"', description: 'Attachment type' },
      { name: '[].imageId', type: 'string', description: 'Image ID for URL resolution' },
      { name: '[].mimeType', type: 'string', description: 'MIME type' },
      { name: '[].filename', type: 'string', description: 'Original filename' },
    ]},
    { name: 'editing', type: 'object', description: 'Edit mode state and callbacks', children: [
      { name: 'active', type: 'boolean', description: 'Currently in edit mode' },
      { name: 'content', type: 'string', description: 'Current edit buffer' },
      { name: 'reasoning', type: 'string', description: 'Current reasoning edit buffer' },
      { name: 'setContent', type: '(s: string) => void', description: 'Update edit content' },
      { name: 'setReasoning', type: '(s: string) => void', description: 'Update edit reasoning' },
      { name: 'save', type: '() => void', description: 'Save edits' },
      { name: 'cancel', type: '() => void', description: 'Cancel editing' },
    ]},
    { name: 'actions', type: 'object', description: 'Action callbacks', children: [
      { name: 'copy', type: '() => void', description: 'Copy message to clipboard' },
      { name: 'edit', type: '() => void', description: 'Enter edit mode' },
      { name: 'delete', type: '() => void', description: 'Delete message' },
      { name: 'toggleHidden', type: '() => void', description: 'Toggle AI context visibility' },
      { name: 'fork', type: '() => void', description: 'Fork chat at this message' },
      { name: 'promptBreakdown', type: '() => void', description: 'Show prompt breakdown' },
      { name: 'swipeLeft', type: '() => void', description: 'Navigate to previous swipe' },
      { name: 'swipeRight', type: '() => void', description: 'Navigate to next swipe' },
    ]},
    { name: 'styles', type: 'Record<string, string>', description: 'Original CSS module class names' },
    { name: '_raw', type: 'Message', description: 'Raw Message object (escape hatch for power users)' },
  ],
}

// ── Tier 2: Generic templates ───────────────────────────────────────

function genericTemplate(name: string, propsNote: string): ComponentTemplate {
  return {
    template: `export default function ${name}(props) {
  // Tier 2 override — receives the component's original props as-is.
  // Available props:
${propsNote}
  //
  // Tip: console.log(props) to inspect all available data.

  return (
    <div>
      <pre style={{ fontSize: 10, opacity: 0.5 }}>
        {JSON.stringify(Object.keys(props), null, 2)}
      </pre>
    </div>
  )
}`,
    props: [],
  }
}

// ── Registry ────────────────────────────────────────────────────────

const TEMPLATES: Record<string, ComponentTemplate> = {
  BubbleMessage: BUBBLE_MESSAGE,
  MinimalMessage: BUBBLE_MESSAGE, // Same props contract

  InputArea: genericTemplate('InputArea', '  //   chatId: string'),

  MessageContent: genericTemplate('MessageContent', [
    '  //   content: string        — raw markdown',
    '  //   isUser: boolean',
    '  //   userName: string',
    '  //   isStreaming?: boolean',
    '  //   messageId?: string',
    '  //   chatId?: string',
    '  //   depth?: number',
  ].join('\n')),

  SwipeControls: genericTemplate('SwipeControls', [
    '  //   message: Message       — full message object',
    '  //   chatId: string',
    '  //   variant?: "default" | "bubble"',
  ].join('\n')),

  StreamingIndicator: genericTemplate('StreamingIndicator', '  //   (no props)'),

  PortraitPanel: genericTemplate('PortraitPanel', '  //   side?: "left" | "right"'),

  ChatView: genericTemplate('ChatView', '  //   (no props — uses useParams and store)'),
}

/** Get the starter template for a component, or a fallback generic one. */
export function getComponentTemplate(componentName: string): ComponentTemplate {
  return TEMPLATES[componentName] ?? {
    template: `export default function ${componentName}(props) {
  // No documented props contract for this component yet.
  // Use console.log(props) to inspect available data.

  return (
    <div>
      <pre style={{ fontSize: 10, opacity: 0.5 }}>
        {JSON.stringify(Object.keys(props), null, 2)}
      </pre>
    </div>
  )
}`,
    props: [],
  }
}
