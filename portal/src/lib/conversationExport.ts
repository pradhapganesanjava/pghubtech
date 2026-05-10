// Export an AI conversation as an HTML file in the PGHubTechDocs Drive
// folder and register it in the Docs sheet so it appears in the Docs view.
//
// Both AskAIPanel and EphemeralAIChat call this from their header save
// button. The conversation is rendered as a self-contained HTML page (each
// turn in a card) so the existing DocViewer's iframe sandbox renders it
// cleanly without extra plumbing.

import { marked } from 'marked'
import { GAuth } from './gauth'
import { sanitizeHtml } from './sanitize'
import { getOrCreateFolder, uploadFileToDrive } from './drive'
import { appendDoc } from '../adapters/docsRepo'
import type { DocRecord } from '../adapters/docsRepo'

const DOCS_FOLDER = 'PGHubTechDocs'

export interface ConvMsg {
  role:    'user' | 'assistant'
  content: string
}

export async function exportConversationAsDoc(
  msgs: ConvMsg[],
  titleHint: string,
  extraTags: string[] = [],
): Promise<DocRecord> {
  if (msgs.length === 0) throw new Error('No messages to save.')
  const token = GAuth.getToken()
  if (!token) throw new Error('Not signed in')

  const now      = new Date()
  const isoDate  = now.toISOString().slice(0, 10)
  const friendly = (
    titleHint ||
    msgs.find(m => m.role === 'user')?.content?.replace(/\s+/g, ' ').slice(0, 60) ||
    'AI Conversation'
  ).trim()
  const alias    = `${friendly} — ${isoDate}`
  const filename = sanitizeFilename(alias) + '.html'

  const html = renderConversationHtml(msgs, friendly, now)
  const blob = new Blob([html], { type: 'text/html' })

  const folderId = await getOrCreateFolder(token, DOCS_FOLDER)
  const { id }   = await uploadFileToDrive(token, folderId, blob, filename, 'text/html')

  const rec: DocRecord = {
    id,
    alias,
    filename,
    mime:      'text/html',
    size:      blob.size,
    tags:      uniqTags(['ai-chat', ...extraTags]),
    createdAt: now.toISOString(),
  }
  await appendDoc(rec)
  return rec
}

function sanitizeFilename(s: string): string {
  return s
    .replace(/[\\/:*?"<>|]/g, '')      // illegal on most filesystems
    .replace(/[^\w\s\-.]/g, '')        // strip anything still exotic
    .replace(/\s+/g, ' ')
    .slice(0, 100)
    .trim() || 'conversation'
}

function uniqTags(tags: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of tags) {
    const v = t.trim()
    if (!v || seen.has(v)) continue
    seen.add(v); out.push(v)
  }
  return out
}

function renderConversationHtml(msgs: ConvMsg[], title: string, when: Date): string {
  const escape = (s: string) => s
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // Each turn's body is rendered as Markdown so code fences, lists,
  // headings, bold/italic, and inline code come through formatted instead
  // of as a wall of plain text. sanitizeHtml strips anything dangerous so
  // the doc is safe to render in the iframe sandbox.
  const turns = msgs.map(m => {
    const html = sanitizeHtml(marked.parse(m.content, { async: false }) as string)
    return `
    <article class="turn ${m.role}">
      <div class="role">${m.role === 'user' ? 'You' : 'AI'}</div>
      <div class="content">${html}</div>
    </article>`
  }).join('\n')
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escape(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         max-width: 860px; margin: 0 auto; padding: 24px;
         color: #1f2228; background: #fff; }
  h1   { font-size: 22px; margin: 0 0 4px; }
  .meta { color: #666; font-size: 12px; margin-bottom: 22px; }
  .turn { margin-bottom: 16px; padding: 14px 18px;
          border-radius: 10px; border: 1px solid #e1e4e8; }
  .turn.user      { background: #f0f7ff; border-color: #cfe3ff; }
  .turn.assistant { background: #fafafa; }
  .role { font-size: 11px; font-weight: 700; text-transform: uppercase;
          letter-spacing: .05em; color: #666; margin-bottom: 8px; }
  .content { font-size: 15px; line-height: 1.6; word-wrap: break-word; }
  .content p { margin: 0 0 10px; }
  .content p:last-child { margin-bottom: 0; }
  .content h1, .content h2, .content h3, .content h4 {
    margin: 14px 0 6px; line-height: 1.3;
  }
  .content h1 { font-size: 18px; }
  .content h2 { font-size: 16px; }
  .content h3 { font-size: 15px; }
  .content h4 { font-size: 14px; }
  .content ul, .content ol { margin: 0 0 10px; padding-left: 22px; }
  .content li { margin-bottom: 4px; }
  .content blockquote {
    margin: 8px 0; padding: 4px 12px;
    border-left: 3px solid #d0d7de; color: #57606a;
    background: rgba(208, 215, 222, .15);
  }
  .content code {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 13px;
    background: rgba(175, 184, 193, .2);
    padding: 1px 5px; border-radius: 4px;
  }
  .content pre {
    margin: 10px 0; padding: 12px 14px;
    background: #0d1117; color: #e6edf3;
    border-radius: 6px;
    overflow-x: auto;
    font-size: 13px; line-height: 1.5;
  }
  .content pre code {
    background: transparent; padding: 0;
    color: inherit; font-size: inherit;
  }
  .content table {
    border-collapse: collapse; margin: 10px 0;
    font-size: 13px;
  }
  .content th, .content td {
    border: 1px solid #d0d7de; padding: 5px 9px;
  }
  .content th { background: #f6f8fa; font-weight: 600; }
  .content a { color: #0969da; }
  .content hr { border: 0; border-top: 1px solid #d0d7de; margin: 14px 0; }
  .content img { max-width: 100%; height: auto; }
</style>
</head>
<body>
<h1>${escape(title)}</h1>
<div class="meta">Saved ${when.toLocaleString()} · ${msgs.length} message${msgs.length === 1 ? '' : 's'}</div>
${turns}
</body>
</html>`
}
