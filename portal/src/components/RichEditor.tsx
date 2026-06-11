import { useEffect, useRef, useState } from 'react'
import { sanitizeHtml, isSafeLinkUrl } from '../lib/sanitize'

// ── Rich text editor (contentEditable + toolbar) ─────────────────────────────

interface ToolbarBtn {
  cmd:    string
  arg?:   string
  label:  string
  title:  string
  style?: React.CSSProperties
}

// Plain execCommand buttons. Richer actions (inline code, table, hr, image,
// colors, HTML embed) are wired as dedicated handlers below.
const TOOLBAR: (ToolbarBtn | 'sep')[] = [
  { cmd: 'bold',          label: 'B',   title: 'Bold (Ctrl+B)',          style: { fontWeight: 700 } },
  { cmd: 'italic',        label: 'I',   title: 'Italic (Ctrl+I)',        style: { fontStyle: 'italic' } },
  { cmd: 'underline',     label: 'U',   title: 'Underline (Ctrl+U)',     style: { textDecoration: 'underline' } },
  { cmd: 'strikeThrough', label: 'S',   title: 'Strikethrough',          style: { textDecoration: 'line-through' } },
  'sep',
  { cmd: 'formatBlock', arg: 'h2',         label: 'H2', title: 'Heading 2',  style: { fontWeight: 700 } },
  { cmd: 'formatBlock', arg: 'h3',         label: 'H3', title: 'Heading 3',  style: { fontWeight: 700 } },
  { cmd: 'formatBlock', arg: 'blockquote', label: '❝',  title: 'Blockquote' },
  { cmd: 'formatBlock', arg: 'pre',        label: '{ }', title: 'Code block', style: { fontFamily: 'monospace', fontSize: 11 } },
  'sep',
  { cmd: 'insertUnorderedList', label: '•≡',  title: 'Bullet list' },
  { cmd: 'insertOrderedList',   label: '1.≡', title: 'Numbered list' },
  { cmd: 'outdent',             label: '⇤',   title: 'Outdent' },
  { cmd: 'indent',              label: '⇥',   title: 'Indent' },
  'sep',
  { cmd: 'justifyLeft',   label: '⟸', title: 'Align left' },
  { cmd: 'justifyCenter', label: '↔', title: 'Align center' },
  { cmd: 'justifyRight',  label: '⟹', title: 'Align right' },
  { cmd: 'justifyFull',   label: '≡', title: 'Justify' },
]

interface Props {
  value:    string
  onChange: (v: string) => void
  // Optional: when provided, image pastes upload via this callback and the
  // returned URL is set as the new <img src>. Without it, image-paste is
  // ignored (text/html paste is still sanitised).
  onPasteImage?: (blob: Blob) => Promise<string>
  // When true, shows the "Insert HTML section" button: drops a non-editable
  // block holding raw HTML (styles/markup) at the caret. The owner is then
  // responsible for expanding `.rf-html-embed[data-html]` placeholders into
  // their raw HTML on save (see AdsHubView).
  allowHtmlEmbed?: boolean
}

export default function RichEditor({ value, onChange, onPasteImage, allowHtmlEmbed }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const lastEmittedRef = useRef<string>(value)
  // Color inputs steal focus from the editor (collapsing the selection), so we
  // snapshot the range when the swatch is pressed and restore it before apply.
  const savedRange = useRef<Range | null>(null)

  // HTML-embed modal state.
  const [embedOpen, setEmbedOpen] = useState(false)
  const [embedText, setEmbedText] = useState('')
  const editingEmbedRef = useRef<HTMLElement | null>(null)

  // Embeds are contenteditable=false; re-assert that after any innerHTML write
  // (sanitize may drop the attribute).
  function hardenEmbeds() {
    ref.current?.querySelectorAll('.rf-html-embed').forEach(el =>
      el.setAttribute('contenteditable', 'false'),
    )
  }

  // Set initial HTML and re-sync when external value changes (e.g. switching
  // pages/cards). Skip the sync when the change came from our own onInput,
  // otherwise the cursor jumps. All writes funnel through sanitizeHtml so
  // untrusted content never hits the DOM with active script.
  useEffect(() => {
    if (!ref.current) return
    if (lastEmittedRef.current !== value) {
      ref.current.innerHTML = sanitizeHtml(value)
      lastEmittedRef.current = value
      hardenEmbeds()
    }
  }, [value])

  useEffect(() => {
    if (ref.current) { ref.current.innerHTML = sanitizeHtml(value); hardenEmbeds() }
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

  function insertHtmlAtCaret(html: string) {
    ref.current?.focus()
    document.execCommand('insertHTML', false, sanitizeHtml(html))
    emit()
  }

  // Wrap the current selection in inline <code>; if nothing is selected,
  // drop an empty <code> for the user to type into.
  function wrapInlineCode() {
    ref.current?.focus()
    const sel = window.getSelection()
    const text = sel && sel.rangeCount ? sel.toString() : ''
    insertHtmlAtCaret(`<code>${text ? text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!)) : '​'}</code>`)
  }

  function saveSelection() {
    const sel = window.getSelection()
    if (sel && sel.rangeCount && ref.current?.contains(sel.anchorNode)) {
      savedRange.current = sel.getRangeAt(0).cloneRange()
    }
  }
  function handleColor(cmd: 'foreColor' | 'hiliteColor', e: React.ChangeEvent<HTMLInputElement>) {
    ref.current?.focus()
    const sel = window.getSelection()
    if (sel && savedRange.current) { sel.removeAllRanges(); sel.addRange(savedRange.current) }
    document.execCommand(cmd, false, e.target.value)
    emit()
  }

  function insertTable() {
    const cell = '<td style="border:1px solid #c8c8c8;padding:6px;min-width:60px">&nbsp;</td>'
    const row  = `<tr>${cell}${cell}${cell}</tr>`
    insertHtmlAtCaret(
      `<table style="border-collapse:collapse;margin:6px 0">${row}${row}</table><p><br></p>`,
    )
  }

  function insertImageByUrl() {
    const url = prompt('Image URL:', 'https://')
    if (!url) return
    if (!isSafeLinkUrl(url)) { alert('Only http(s) image URLs are allowed.'); return }
    insertHtmlAtCaret(`<img src="${url.trim()}" style="max-width:100%" alt=""/>`)
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

  // ── HTML embed block ───────────────────────────────────────────────────────
  // Build the non-editable placeholder. The raw HTML lives verbatim in
  // data-html (escaped by the DOM serializer); the visible body is a sanitised
  // preview so the editor never executes the embedded markup.
  function buildEmbedNode(raw: string): HTMLElement {
    const ph = document.createElement('div')
    ph.className = 'rf-html-embed'
    ph.setAttribute('contenteditable', 'false')
    ph.setAttribute('data-html', raw)
    ph.innerHTML =
      '<div class="rf-html-embed-label">⧉ HTML section — click to edit</div>' +
      `<div class="rf-html-embed-preview">${sanitizeHtml(raw) || '<em>empty</em>'}</div>`
    return ph
  }

  function openEmbed(el?: HTMLElement) {
    saveSelection()
    editingEmbedRef.current = el ?? null
    setEmbedText(el ? (el.getAttribute('data-html') ?? '') : '')
    setEmbedOpen(true)
  }

  function confirmEmbed() {
    const raw = embedText
    const el  = editingEmbedRef.current
    if (el) {
      // Update existing embed in place.
      el.setAttribute('data-html', raw)
      const prev = el.querySelector('.rf-html-embed-preview')
      if (prev) prev.innerHTML = sanitizeHtml(raw) || '<em>empty</em>'
      emit()
    } else {
      // Insert a fresh embed at the saved caret, with a paragraph after it so
      // the user can keep writing rich text below the section.
      ref.current?.focus()
      const sel = window.getSelection()
      if (sel && savedRange.current) { sel.removeAllRanges(); sel.addRange(savedRange.current) }
      insertHtmlAtCaret(buildEmbedNode(raw).outerHTML + '<p><br></p>')
      hardenEmbeds()
    }
    setEmbedOpen(false)
    setEmbedText('')
    editingEmbedRef.current = null
  }

  function handleEditorClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!allowHtmlEmbed) return
    const el = (e.target as HTMLElement).closest('.rf-html-embed') as HTMLElement | null
    if (el) { e.preventDefault(); openEmbed(el) }
  }

  // The <pre> code block the caret is currently inside, or null.
  function currentPre(): HTMLElement | null {
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount || !ref.current) return null
    let node: Node | null = sel.anchorNode
    while (node && node !== ref.current) {
      if (node.nodeType === 1 && (node as HTMLElement).tagName === 'PRE') return node as HTMLElement
      node = node.parentNode
    }
    return null
  }

  // Code block button: wrap the line in <pre>, then guarantee an empty
  // paragraph right after it so there's always normal-text space below the
  // block (you can click into it, or double-Enter out — see handleKeyDown).
  function makeCodeBlock() {
    exec('formatBlock', 'pre')
    const pre = currentPre()
    if (pre && ref.current && !pre.nextElementSibling) {
      const p = document.createElement('p')
      p.innerHTML = '<br>'
      pre.after(p)          // caret stays in the <pre>
      emit()
    }
  }

  // True after a lone Enter pressed inside a <pre> (reset by any other key) —
  // lets a second Enter on a blank line break OUT of the code block.
  const dblEnterRef = useRef(false)

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
      dblEnterRef.current = false
      return
    }
    // Inside a code block: a second Enter (on a blank line) breaks OUT of the
    // <pre> into a normal paragraph below, instead of adding more blank lines.
    if (e.key === 'Enter' && !e.shiftKey && currentPre()) {
      if (dblEnterRef.current) {
        e.preventDefault()
        document.execCommand('delete')   // remove the blank line the first Enter made
        newParagraphBelow()
        dblEnterRef.current = false
      } else {
        dblEnterRef.current = true       // first Enter — let it add a newline
      }
      return
    }
    dblEnterRef.current = false
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
        insertHtmlAtCaret(
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
              title={b.cmd === 'formatBlock' && b.arg === 'pre' ? 'Code block (↵↵ on a blank line to exit)' : b.title}
              style={b.style}
              onClick={() => (b.cmd === 'formatBlock' && b.arg === 'pre') ? makeCodeBlock() : exec(b.cmd, b.arg)}
            >
              {b.label}
            </button>
          )
        )}
        <button type="button" className="rf-tb-btn" title="Inline code" style={{ fontFamily: 'monospace' }} onClick={wrapInlineCode}>M</button>
        <span className="rf-tb-divider" />
        {/* Text colour */}
        <label className="rf-tb-btn rf-tb-color" title="Text colour">
          A
          <input type="color" onMouseDown={e => { e.stopPropagation(); saveSelection() }} onChange={e => handleColor('foreColor', e)} />
        </label>
        {/* Highlight colour */}
        <label className="rf-tb-btn rf-tb-color" title="Highlight">
          🖍
          <input type="color" defaultValue="#ffff00" onMouseDown={e => { e.stopPropagation(); saveSelection() }} onChange={e => handleColor('hiliteColor', e)} />
        </label>
        <span className="rf-tb-divider" />
        <button type="button" className="rf-tb-btn" title="Insert table" onClick={insertTable}>⊞</button>
        <button type="button" className="rf-tb-btn" title="Horizontal line" onClick={() => exec('insertHorizontalRule')}>—</button>
        <button type="button" className="rf-tb-btn" title="Insert link" onClick={handleLink}>🔗</button>
        <button type="button" className="rf-tb-btn" title="Insert image by URL" onClick={insertImageByUrl}>🖼</button>
        {allowHtmlEmbed && (
          <button type="button" className="rf-tb-btn" title="Insert HTML section (styles/markup render on save)" onClick={() => openEmbed()}>＋&lt;/&gt;</button>
        )}
        <span className="rf-tb-divider" />
        <button type="button" className="rf-tb-btn" title="New line below this block — exit a code block / heading / quote (Ctrl/Cmd+Enter)" onClick={newParagraphBelow}>¶</button>
        <button type="button" className="rf-tb-btn" title="Clear formatting" onClick={() => exec('removeFormat')}>⊘</button>
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
        onClick={handleEditorClick}
      />

      {embedOpen && (
        <div className="rf-embed-modal">
          <div className="rf-embed-modal-hd">{editingEmbedRef.current ? 'Edit HTML section' : 'Insert HTML section'}</div>
          <textarea
            className="rf-embed-textarea"
            autoFocus
            spellCheck={false}
            value={embedText}
            onChange={e => setEmbedText(e.target.value)}
            placeholder={'<style>.box{padding:8px;border:1px solid #888}</style>\n<div class="box">Your HTML…</div>'}
          />
          <div className="rf-embed-modal-actions">
            <button className="rf-btn-cancel" onClick={() => { setEmbedOpen(false); setEmbedText(''); editingEmbedRef.current = null }}>Cancel</button>
            <button className="rf-btn-save" onClick={confirmEmbed}>{editingEmbedRef.current ? 'Update' : 'Insert'}</button>
          </div>
        </div>
      )}
    </div>
  )
}
