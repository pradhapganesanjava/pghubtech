// PageBlocksEditor — each Notes page is a stack of indentable rich-text
// blocks (think Notion). Each block has its own depth level (visual indent)
// and a Rich/HTML/Preview tab strip mirroring the Browse → Detail edit mode.
//
// Persistence: the array is JSON-serialised and prefixed with a sentinel
// inside node.content. Plain-HTML legacy content is auto-wrapped as a
// single depth-0 block, so older pages keep loading.

import { useState } from 'react'
import RichEditor from './RichEditor'
import { sanitizeHtml } from '../lib/sanitize'

const SENTINEL  = '__PGBLOCKS__\n'
const MAX_DEPTH = 6

export type BlockKind = 'content' | 'spacer'

export interface PageBlock {
  id:    string
  depth: number          // 0 .. MAX_DEPTH
  html:  string
  kind?: BlockKind       // omitted → 'content' (back-compat)
}

function blockUuid(): string {
  return `b-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function parseBlocks(content: string): PageBlock[] {
  if (content.startsWith(SENTINEL)) {
    try {
      const data = JSON.parse(content.slice(SENTINEL.length))
      if (Array.isArray(data)) {
        const cleaned = data
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .filter((d: any) => typeof d?.id === 'string')
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .map((d: any): PageBlock => ({
            id:    String(d.id),
            depth: Math.max(0, Math.min(MAX_DEPTH, parseInt(d.depth, 10) || 0)),
            html:  String(d.html ?? ''),
            kind:  d.kind === 'spacer' ? 'spacer' : 'content',
          }))
        if (cleaned.length > 0) return cleaned
      }
    } catch { /* fall through */ }
  }
  // Legacy plain-HTML content → one depth-0 block.
  return [{ id: blockUuid(), depth: 0, html: content || '', kind: 'content' }]
}

export function serializeBlocks(blocks: PageBlock[]): string {
  if (blocks.length === 0) return ''
  // If there's only one depth-0 content block, store as plain HTML so the
  // row is human-readable in the raw Sheet for trivial pages.
  const onlyOne = blocks.length === 1
  if (onlyOne && blocks[0].depth === 0 && (blocks[0].kind ?? 'content') === 'content') {
    return blocks[0].html
  }
  return SENTINEL + JSON.stringify(blocks.map(b => ({
    id:    b.id,
    depth: b.depth,
    html:  b.html,
    kind:  b.kind ?? 'content',
  })))
}

export function newBlock(depth = 0, html = '', kind: BlockKind = 'content'): PageBlock {
  return { id: blockUuid(), depth, html, kind }
}

// Render the block array as one sanitised HTML stream — used by NotesView's
// view mode so the whole page reads as a single document.
//
// Each <table> is wrapped in a `<div class="page-table-wrap">` so wide
// tables scroll horizontally inside the block rather than stretching the
// whole page. Tables are rarely nested, so the simple regex wrap is safe.
export function renderBlocksAsHtml(blocks: PageBlock[]): string {
  if (blocks.length === 0) return '<em style="opacity:.5">(empty)</em>'
  return blocks.map(b => {
    const indent = b.depth * 24
    if ((b.kind ?? 'content') === 'spacer') {
      return `<div style="margin-left:${indent}px;height:18px"></div>`
    }
    const html = wrapTables(b.html)
    return `<div class="page-render-block" style="margin-left:${indent}px">${html}</div>`
  }).join('\n')
}

function wrapTables(html: string): string {
  if (!html.includes('<table')) return html
  return html
    .replace(/<table([\s>])/gi, '<div class="page-table-wrap"><table$1')
    .replace(/<\/table>/gi, '</table></div>')
}

interface Props {
  blocks:        PageBlock[]
  onChange:      (next: PageBlock[]) => void
  onPasteImage?: (blob: Blob) => Promise<string>
}

export default function PageBlocksEditor({ blocks, onChange, onPasteImage }: Props) {
  function patchBlock(id: string, patch: Partial<PageBlock>) {
    onChange(blocks.map(b => b.id === id ? { ...b, ...patch } : b))
  }
  function addBlock() {
    onChange([...blocks, newBlock()])
  }
  function addSpacer() {
    onChange([...blocks, newBlock(0, '', 'spacer')])
  }
  function deleteBlock(id: string) {
    onChange(blocks.filter(b => b.id !== id))
  }
  function indent(id: string) {
    const b = blocks.find(x => x.id === id)
    if (b) patchBlock(id, { depth: Math.min(MAX_DEPTH, b.depth + 1) })
  }
  function outdent(id: string) {
    const b = blocks.find(x => x.id === id)
    if (b) patchBlock(id, { depth: Math.max(0, b.depth - 1) })
  }
  function move(id: string, dir: -1 | 1) {
    const i = blocks.findIndex(x => x.id === id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= blocks.length) return
    const next = [...blocks]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }

  return (
    <div className="page-blocks">
      {blocks.map((b, i) => (
        <BlockView
          key={b.id}
          block={b}
          first={i === 0}
          last={i === blocks.length - 1}
          onChangeHtml={v => patchBlock(b.id, { html: v })}
          onIndent={() => indent(b.id)}
          onOutdent={() => outdent(b.id)}
          onMoveUp={() => move(b.id, -1)}
          onMoveDown={() => move(b.id, +1)}
          onDelete={() => deleteBlock(b.id)}
          onPasteImage={onPasteImage}
        />
      ))}
      <div className="page-block-add-row">
        <button className="page-block-add" type="button" onClick={addBlock}>
          ＋ Block
        </button>
        <button className="page-block-add page-block-add-spacer" type="button" onClick={addSpacer}>
          ＋ Spacer
        </button>
      </div>
    </div>
  )
}

type Mode = 'rich' | 'html' | 'preview'

function BlockView({
  block, first, last,
  onChangeHtml, onIndent, onOutdent, onMoveUp, onMoveDown, onDelete, onPasteImage,
}: {
  block:          PageBlock
  first:          boolean
  last:           boolean
  onChangeHtml:   (v: string) => void
  onIndent:       () => void
  onOutdent:      () => void
  onMoveUp:       () => void
  onMoveDown:     () => void
  onDelete:       () => void
  onPasteImage?:  (blob: Blob) => Promise<string>
}) {
  const [mode, setMode] = useState<Mode>('rich')
  const indentPx = block.depth * 24
  const isSpacer = (block.kind ?? 'content') === 'spacer'

  if (isSpacer) {
    return (
      <div
        className="page-spacer"
        style={{ marginLeft: indentPx }}
        title="Blank line"
      >
        <span className="page-spacer-line" />
        <span className="page-spacer-actions">
          <button className="pgb-btn" type="button" onClick={onMoveUp} disabled={first} title="Move up">↑</button>
          <button className="pgb-btn" type="button" onClick={onMoveDown} disabled={last} title="Move down">↓</button>
          <button className="pgb-btn" type="button" onClick={onOutdent} disabled={block.depth === 0} title="Outdent">⇤</button>
          <button className="pgb-btn" type="button" onClick={onIndent}  disabled={block.depth >= 6}     title="Indent">⇥</button>
          <button className="pgb-btn page-block-rm" type="button" onClick={onDelete} title="Remove blank line">✕</button>
        </span>
      </div>
    )
  }

  return (
    <div
      className="page-block"
      style={{ marginLeft: indentPx }}
      data-depth={block.depth}
    >
      <div className="page-block-toolbar">
        <button
          className="pgb-btn"
          type="button"
          onClick={onOutdent}
          disabled={block.depth === 0}
          title="Outdent"
        >⇤</button>
        <button
          className="pgb-btn"
          type="button"
          onClick={onIndent}
          disabled={block.depth >= MAX_DEPTH}
          title="Indent"
        >⇥</button>
        <span className="page-block-depth">L{block.depth}</span>

        <div className="page-block-mode">
          {(['rich', 'html', 'preview'] as Mode[]).map(m => (
            <button
              key={m}
              type="button"
              className={`pgb-btn pgb-mode${mode === m ? ' active' : ''}`}
              onClick={() => setMode(m)}
            >{m === 'rich' ? 'Rich' : m === 'html' ? 'HTML' : 'Preview'}</button>
          ))}
        </div>

        <button
          className="pgb-btn"
          type="button"
          onClick={onMoveUp}
          disabled={first}
          title="Move up"
        >↑</button>
        <button
          className="pgb-btn"
          type="button"
          onClick={onMoveDown}
          disabled={last}
          title="Move down"
        >↓</button>
        <button
          className="pgb-btn page-block-rm"
          type="button"
          onClick={onDelete}
          title="Remove block"
        >✕</button>
      </div>

      {mode === 'rich' && (
        <RichEditor
          value={block.html}
          onChange={onChangeHtml}
          onPasteImage={onPasteImage}
        />
      )}
      {mode === 'html' && (
        <textarea
          className="rf-textarea page-block-html"
          value={block.html}
          rows={8}
          spellCheck={false}
          onChange={e => onChangeHtml(e.target.value)}
        />
      )}
      {mode === 'preview' && (
        <div
          className="rf-html-preview section-html-body page-block-preview"
          dangerouslySetInnerHTML={{
            __html: block.html
              ? sanitizeHtml(block.html)
              : '<em style="opacity:.5">(empty)</em>',
          }}
        />
      )}
    </div>
  )
}
