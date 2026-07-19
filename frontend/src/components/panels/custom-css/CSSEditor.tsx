import { forwardRef, useRef, useEffect, useImperativeHandle } from 'react'
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, type Extension } from '@codemirror/state'
import { css } from '@codemirror/lang-css'
import { oneDark } from '@codemirror/theme-one-dark'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { syntaxHighlighting, defaultHighlightStyle, bracketMatching, foldGutter, foldKeymap } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap, autocompletion } from '@codemirror/autocomplete'
import { lintGutter } from '@codemirror/lint'
import styles from './CSSEditor.module.css'

interface CodeEditorProps {
  value: string
  onChange: (value: string) => void
  /** Language extension — defaults to CSS. Pass a different extension for TSX etc. */
  language?: Extension
  /** Optional extra extensions */
  extensions?: Extension[]
}

export interface CodeEditorHandle {
  insertText: (text: string) => void
  replaceSelection: (text: string) => void
}

const CodeEditor = forwardRef<CodeEditorHandle, CodeEditorProps>(function CodeEditor({ value, onChange, language, extensions = [] }, ref) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  const suppressRef = useRef(false)
  const valueRef = useRef(value)
  valueRef.current = value
  const extensionsRef = useRef(extensions)
  extensionsRef.current = extensions
  const langRef = useRef(language)
  langRef.current = language

  // Recreate editor when language mode changes. Value and extension updates
  // are read from refs so keystrokes don't destroy and recreate the editor.
  useEffect(() => {
    if (!containerRef.current) return

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !suppressRef.current) {
        onChangeRef.current(update.state.doc.toString())
      }
    })

    const lang = langRef.current ?? css()

    const state = EditorState.create({
      doc: valueRef.current,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        foldGutter(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        lang,
        oneDark,
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        lintGutter(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...closeBracketsKeymap,
        ]),
        ...(extensionsRef.current ?? []),
        updateListener,
        EditorView.lineWrapping,
      ],
    })

    const view = new EditorView({ state, parent: containerRef.current })
    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
  }, [language])

  // Sync external value changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const currentDoc = view.state.doc.toString()
    if (currentDoc !== value) {
      suppressRef.current = true
      view.dispatch({
        changes: { from: 0, to: currentDoc.length, insert: value },
      })
      suppressRef.current = false
    }
  }, [value])

  useImperativeHandle(ref, () => ({
    insertText(text: string) {
      const view = viewRef.current
      if (!view) return
      const { to } = view.state.selection.main
      view.dispatch({
        changes: { from: to, to, insert: text },
        selection: { anchor: to + text.length },
      })
      view.focus()
    },
    replaceSelection(text: string) {
      const view = viewRef.current
      if (!view) return
      const { from, to } = view.state.selection.main
      view.dispatch({
        changes: { from, to, insert: text },
        selection: { anchor: from + text.length },
      })
      view.focus()
    },
  }), [])

  return <div ref={containerRef} className={styles.editor} />
})

export default CodeEditor
