import { useEffect, useRef } from 'react'
import { sanitizeHtml, isSafeLinkUrl } from '../lib/sanitize'

// ── Rich text editor (contentEditable + toolbar) ─────────────────────────────

interface ToolbarBtn {
  cmd:    string
  arg?:   string
  label:  string
  title:  string
  style?: React.CSSProperties
}

const TOOLBAR: (ToolbarBtn | 'sep')[] = [
  { cmd: 'bold',          label: 'B',   title: 'Bold (Ctrl+B)',          style: { fontWeight: 700 } },
  { cmd: 'italic',        label: 'I',   title: 'Italic (Ctrl+I)',        style: { fontStyle: 'italic' } },
  { cmd: 'underline',     label: 'U',   title: 'Underline (Ctrl+U)',     style: { textDecoration: 'underline' } },
  { cmd: 'strikeThrough', label: 'S',   title: 'Strikethrough',          style: { textDecoration: 'line-through' } },
  'sep',
  { cmd: 'formatBlock', arg: 'h2',         label: 'H',  title: 'Heading',           style: { fontWeight: 700 } },
  { cmd: 'formatBlock', arg: 'blockquote', label: '❝',  title: 'Blockquote' },
  { cmd: 'formatBlock', arg: 'pre',        label: '</>', title: 'Code block',       style: { fontFamily: 'monospace', fontSize: 11 } },
  'sep',
  { cmd: 'insertUnorderedList', label: '• ≡', title: 'Bullet list' },
  { cmd: 'insertOrderedList',   label: '1. ≡', title: 'Numbered list' },
  { cmd: 'outdent',             label: '⇤',   title: 'Outdent' },
  { cmd: 'indent',              label: '⇥',   title: 'Indent' },
  'sep',
  { cmd: 'removeFormat',        label: '✕',   title: 'Clear formatting' },
]

interface Props {
  value:    string
  onChange: (v: string) => void
  // Optional: when provided, image pastes upload via this callback and the
  // returned URL is set as the new <img src>. Without it, image-paste is
  // ignored (text/html paste is still sanitised).
  onPasteImage?: (blob: Blob) => Promise<string>
}

export default function RichEditor({ value, onChange, onPasteImage }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const lastEmittedRef = useRef<string>(value)

  // Set initial HTML and re-sync when external value changes (e.g. switching
  // pages/cards). Skip the sync when the change came from our own onInput,
  // otherwise the cursor jumps. All writes funnel through sanitizeHtml so
  // untrusted content never hits the DOM with active script.
  useEffect(() => {
    if (!ref.current) return
    if (lastEmittedRef.current !== value) {
      ref.current.innerHTML = sanitizeHtml(value)
      lastEmittedRef.current = value
    }
  }, [value])

  useEffect(() => {
    if (ref.current) ref.current.innerHTML = sanitizeHtml(value)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function emit() {
    if (!ref.current) return
    const html = ref.current.innerHTML
    lastEmittedRef.current = html
    onChange(html)
  }

  function exec(cmd: string, arg?: string) {
    ref.current?.focus()
    document.execCommand(cmd, false, arg)
    emit()
  }

  function handleLink() {
    const url = prompt('Link URL:', 'https://')
    if (!url) return
    if (!isSafeLinkUrl(url)) {
      alert('Only http(s), mailto, tel and relative links are allowed.')
      return
    }
    exec('createLink', url.trim())
  }

  // Insert a fresh <p> immediately after the block the caret is in (so the
  // user can escape a <pre>/<blockquote>/<h2>/etc. and keep typing normal
  // text below). Bound to the ¶ toolbar button and Ctrl/Cmd+Enter.
  function newParagraphBelow() {
    if (!ref.current) return
    ref.current.focus()
    const sel = window.getSelection()
    const root = ref.current
    let blockEl: Node | null = null
    if (sel && sel.rangeCount > 0) {
      let node: Node | null = sel.anchorNode
      while (node && node !== root && node.parentNode !== root) node = node.parentNode
      if (node && node !== root) blockEl = node
    }
    const p = document.createElement('p')
    p.innerHTML = '<br>'
    if (blockEl && blockEl.parentNode === root) {
      root.insertBefore(p, blockEl.nextSibling)
    } else {
      root.appendChild(p)
    }
    const range = document.createRange()
    range.setStart(p, 0)
    range.collapse(true)
    sel?.removeAllRanges()
    sel?.addRange(range)
    emit()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Ctrl/Cmd + Enter → escape the current block and start a new paragraph.
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault()
      newParagraphBelow()
    }
  }

  function insertImageHtml(html: string) {
    ref.current?.focus()
    document.execCommand('insertHTML', false, sanitizeHtml(html))
    emit()
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    if (!e.clipboardData) return

    const html = e.clipboardData.getData('text/html')
    const items = Array.from(e.clipboardData.items)
    const imgs  = items.filter(it => it.kind === 'file' && it.type.startsWith('image/'))

    if (imgs.length === 0) {
      if (html) {
        e.preventDefault()
        ref.current?.focus()
        document.execCommand('insertHTML', false, sanitizeHtml(html))
        emit()
      }
      return
    }

    if (!onPasteImage) return
    e.preventDefault()
    for (const it of imgs) {
      const file = it.getAsFile()
      if (!file) continue
      const placeholderId = `pgh-img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const reader = new FileReader()
      reader.onload = () => {
        const dataUrl = reader.result as string
        insertImageHtml(
          `<img id="${placeholderId}" src="${dataUrl}" data-uploading="1" ` +
          `style="opacity:.45;max-width:100%" alt="uploading…"/>`
        )
        onPasteImage(file)
          .then(url => {
            const el = ref.current?.querySelector(`#${placeholderId}`) as HTMLImageElement | null
            if (!el) return
            el.removeAttribute('id')
            el.removeAttribute('data-uploading')
            el.style.opacity = ''
            el.src = url
            emit()
          })
          .catch(err => {
            const el = ref.current?.querySelector(`#${placeholderId}`)
            if (el) {
              el.outerHTML = sanitizeHtml(
                `<span style="color:#e94545;font-size:12px">[image upload failed: ${
                  (err as Error).message
                }]</span>`
              )
            }
            emit()
          })
      }
      reader.readAsDataURL(file)
    }
  }

  return (
    <div className="rf-rich-wrap">
      <div className="rf-rich-toolbar" onMouseDown={e => e.preventDefault()}>
        {TOOLBAR.map((b, i) =>
          b === 'sep' ? (
            <span key={`s${i}`} className="rf-tb-divider" />
          ) : (
            <button
              key={b.cmd + (b.arg ?? '')}
              type="button"
              className="rf-tb-btn"
              title={b.title}
              style={b.style}
              onClick={() => exec(b.cmd, b.arg)}
            >
              {b.label}
            </button>
          )
        )}
        <button
          type="button"
          className="rf-tb-btn"
          title="Insert link"
          onClick={handleLink}
        >
          🔗
        </button>
        <button
          type="button"
          className="rf-tb-btn"
          title="New paragraph below current block (Ctrl/Cmd+Enter)"
          onClick={newParagraphBelow}
        >
          ¶
        </button>
      </div>
      <div
        ref={ref}
        className="rf-rich-editor"
        contentEditable
        suppressContentEditableWarning
        onInput={emit}
        onBlur={emit}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
      />
    </div>
  )
}
