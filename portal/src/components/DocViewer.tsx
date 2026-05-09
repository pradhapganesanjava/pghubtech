import { useEffect, useState } from 'react'
import { marked } from 'marked'
import { GAuth } from '../lib/gauth'
import { fetchDriveFile } from '../lib/drive'
import { sanitizeHtml } from '../lib/sanitize'
import type { DocRecord } from '../adapters/docsRepo'

interface Props {
  doc: DocRecord
}

type Kind = 'html' | 'pdf' | 'markdown' | 'text' | 'image' | 'unknown'

function classify(doc: DocRecord): Kind {
  const name = doc.filename.toLowerCase()
  const mime = doc.mime.toLowerCase()
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (mime === 'text/html'       || name.endsWith('.html') || name.endsWith('.htm')) return 'html'
  if (mime === 'text/markdown'   || name.endsWith('.md')   || name.endsWith('.markdown')) return 'markdown'
  if (mime.startsWith('text/'))  return 'text'
  if (mime.startsWith('image/')) return 'image'
  return 'unknown'
}

export default function DocViewer({ doc }: Props) {
  const kind = classify(doc)
  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [textBody, setText]   = useState<string | null>(null)
  const [error, setError]     = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setBlobUrl(null); setText(null); setError(''); setLoading(true)
    let cancelled = false
    let createdUrl: string | null = null
    ;(async () => {
      try {
        const token = GAuth.getToken()
        if (!token) throw new Error('Not signed in')
        const blob = await fetchDriveFile(token, doc.id)
        if (cancelled) return
        if (kind === 'markdown' || kind === 'text') {
          setText(await blob.text())
        } else {
          createdUrl = URL.createObjectURL(blob)
          setBlobUrl(createdUrl)
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
      if (createdUrl) URL.revokeObjectURL(createdUrl)
    }
  }, [doc.id, kind])

  if (loading) {
    return (
      <div className="doc-viewer-state">
        <div className="spinner" />
        <span>Loading {doc.alias}…</span>
      </div>
    )
  }
  if (error) {
    return <div className="doc-viewer-state error">Failed to load: {error}</div>
  }

  if (kind === 'html' && blobUrl) {
    return (
      <iframe
        title={doc.alias}
        src={blobUrl}
        className="doc-iframe"
        sandbox="allow-scripts allow-popups allow-forms allow-same-origin"
      />
    )
  }
  if (kind === 'pdf' && blobUrl) {
    return <iframe title={doc.alias} src={blobUrl} className="doc-iframe" />
  }
  if (kind === 'image' && blobUrl) {
    return (
      <div className="doc-image-wrap">
        <img src={blobUrl} alt={doc.alias} />
      </div>
    )
  }
  if (kind === 'markdown' && textBody != null) {
    const html = sanitizeHtml(marked.parse(textBody, { async: false }) as string)
    return <div className="doc-md section-html-body" dangerouslySetInnerHTML={{ __html: html }} />
  }
  if (kind === 'text' && textBody != null) {
    return <pre className="doc-text">{textBody}</pre>
  }

  return (
    <div className="doc-viewer-state">
      <span>Preview not supported for this file type ({doc.mime}).</span>
      {blobUrl && (
        <a className="doc-download-link" href={blobUrl} download={doc.filename}>
          Download {doc.filename}
        </a>
      )}
    </div>
  )
}
