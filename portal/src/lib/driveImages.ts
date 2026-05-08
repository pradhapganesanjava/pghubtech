// Browser-side helpers to upload images to Google Drive and reference them
// from the Sheet via the authenticated Drive media URL.
//
// Mirrors the Node-side helper in scripts/anki-to-sheets.mjs.

const FOLDER_NAME = 'PGHubTechImages'
export const DRIVE_API_PREFIX = 'https://www.googleapis.com/drive/v3/files/'
export const DRIVE_API_RE     = /https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[A-Za-z0-9_-]+\?alt=media/g

let cachedFolderId: string | null = null

export async function getOrCreateImageFolder(token: string): Promise<string> {
  if (cachedFolderId) return cachedFolderId

  const q   = `name='${FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`
  const r1  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r1.ok) throw new Error(`Drive folder lookup failed: ${r1.status}`)
  const data = await r1.json() as { files?: { id: string }[] }
  if (data.files?.length) {
    cachedFolderId = data.files[0].id
    return cachedFolderId
  }

  const r2 = await fetch('https://www.googleapis.com/drive/v3/files', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })
  if (!r2.ok) throw new Error(`Drive folder create failed: ${r2.status}`)
  const created = await r2.json() as { id: string }
  cachedFolderId = created.id
  return cachedFolderId
}

export async function uploadImageBlob(
  token:    string,
  folderId: string,
  blob:     Blob,
  filename: string,
): Promise<string> {
  const boundary = 'pghtech_' + Math.random().toString(36).slice(2)
  const metadata = { name: filename, parents: [folderId] }
  const parts: BlobPart[] = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    `Content-Type: ${blob.type || 'image/png'}\r\n\r\n`,
    blob,
    `\r\n--${boundary}--`,
  ]
  const body = new Blob(parts)

  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
    {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    },
  )
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Drive upload failed (${res.status}): ${err.slice(0, 160)}`)
  }
  const { id } = await res.json() as { id: string }
  return `${DRIVE_API_PREFIX}${id}?alt=media`
}

export function inferFilename(blob: Blob): string {
  const subtype = (blob.type.split('/')[1] || 'png').replace('+xml', '')
  const stamp   = Date.now().toString(36)
  const rand    = Math.random().toString(36).slice(2, 6)
  return `paste_${stamp}_${rand}.${subtype}`
}

// Walk an HTML string, upload every <img src="data:image/..."> blob to Drive,
// and return the rewritten HTML with Drive URLs.
export async function uploadInlineDataImages(html: string, token: string): Promise<string> {
  if (!/<img[^>]+src="data:image\//i.test(html)) return html
  const folderId  = await getOrCreateImageFolder(token)
  const container = document.createElement('div')
  container.innerHTML = html
  const imgs = Array.from(container.querySelectorAll('img[src^="data:image/"]')) as HTMLImageElement[]
  for (const img of imgs) {
    const src  = img.getAttribute('src')!
    const blob = await (await fetch(src)).blob()
    const url  = await uploadImageBlob(token, folderId, blob, inferFilename(blob))
    img.setAttribute('src', url)
  }
  return container.innerHTML
}
