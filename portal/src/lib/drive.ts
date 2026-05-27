// Generic Drive helpers: folder lookup/create, multipart upload, auth-fetch,
// delete. Used by both the image-paste path and the Docs uploader.

export const DRIVE_API_PREFIX = 'https://www.googleapis.com/drive/v3/files/'
export const DRIVE_API_RE     = /https:\/\/www\.googleapis\.com\/drive\/v3\/files\/[A-Za-z0-9_-]+\?alt=media/g

const FOLDER_ID_CACHE = new Map<string, string>()

export async function getOrCreateFolder(token: string, name: string): Promise<string> {
  const cached = FOLDER_ID_CACHE.get(name)
  if (cached) return cached

  const q   = `name='${name.replace(/'/g, "\\'")}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id)&pageSize=1`
  const r1  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
  if (!r1.ok) throw new Error(`Drive folder lookup failed: ${r1.status}`)
  const data = await r1.json() as { files?: { id: string }[] }
  if (data.files?.length) {
    FOLDER_ID_CACHE.set(name, data.files[0].id)
    return data.files[0].id
  }

  const r2 = await fetch('https://www.googleapis.com/drive/v3/files', {
    method:  'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder' }),
  })
  if (!r2.ok) throw new Error(`Drive folder create failed: ${r2.status}`)
  const created = await r2.json() as { id: string }
  FOLDER_ID_CACHE.set(name, created.id)
  return created.id
}

export interface DriveUploadResult {
  id:  string
  url: string  // authenticated media URL
}

export async function uploadFileToDrive(
  token:        string,
  folderId:     string,
  blob:         Blob,
  filename:     string,
  fallbackMime: string = 'application/octet-stream',
): Promise<DriveUploadResult> {
  const boundary = 'pghtech_' + Math.random().toString(36).slice(2)
  const metadata = { name: filename, parents: [folderId] }
  const parts: BlobPart[] = [
    `--${boundary}\r\n`,
    'Content-Type: application/json; charset=UTF-8\r\n\r\n',
    JSON.stringify(metadata),
    `\r\n--${boundary}\r\n`,
    `Content-Type: ${blob.type || fallbackMime}\r\n\r\n`,
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
  return { id, url: `${DRIVE_API_PREFIX}${id}?alt=media` }
}

// Overwrite an existing Drive file's contents in place (keeps the same file
// id, so anything referencing it — e.g. a sheet's notes_drive_id — stays
// valid). Used when re-saving an edited note.
export async function updateDriveFileContent(
  token:  string,
  fileId: string,
  blob:   Blob,
): Promise<void> {
  const res = await fetch(
    `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
    {
      method:  'PATCH',
      headers: {
        Authorization:  `Bearer ${token}`,
        'Content-Type': blob.type || 'application/octet-stream',
      },
      body: blob,
    },
  )
  if (!res.ok) {
    const err = await res.text().catch(() => '')
    throw new Error(`Drive update failed (${res.status}): ${err.slice(0, 160)}`)
  }
}

// Auth-fetch a Drive file's bytes. Returns the raw Blob so the caller can
// either createObjectURL (iframe src) or read as text/json.
export async function fetchDriveFile(token: string, fileId: string): Promise<Blob> {
  const res = await fetch(`${DRIVE_API_PREFIX}${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) throw new Error(`Drive fetch failed: ${res.status}`)
  return res.blob()
}

export async function deleteDriveFile(token: string, fileId: string): Promise<void> {
  const res = await fetch(`${DRIVE_API_PREFIX}${fileId}`, {
    method:  'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok && res.status !== 404) {
    throw new Error(`Drive delete failed: ${res.status}`)
  }
}

// Walk an HTML string, auth-fetch every Drive media URL, and replace each
// with a blob: URL the <img> tag can load without a header. Used by both
// NoteDetailPanel and HomeView so flashcard images render in the review
// flow as well as the detail panel.
//
// Mutates the passed-in `blobUrls` array (so caller can revoke on unmount)
// and the `blobToDrive` map (used for round-tripping when saving back).
export async function resolveDriveImagesInHtml(
  html:        string,
  token:       string,
  blobUrls:    string[],
  blobToDrive: Map<string, string>,
): Promise<string> {
  const matches = [...html.matchAll(DRIVE_API_RE)]
  if (!matches.length) return html
  let out = html
  for (const [url] of matches) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!res.ok) continue
      const blobUrl = URL.createObjectURL(await res.blob())
      blobUrls.push(blobUrl)
      blobToDrive.set(blobUrl, url)
      out = out.replaceAll(url, blobUrl)
    } catch { /* keep original src on fetch failure */ }
  }
  return out
}
