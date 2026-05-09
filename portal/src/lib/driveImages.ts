// Image-specific Drive helpers built on top of the generic lib/drive.ts
// primitives. Used by the rich-text editor's paste handler.

import {
  DRIVE_API_PREFIX,
  DRIVE_API_RE,
  getOrCreateFolder,
  uploadFileToDrive,
} from './drive'

export { DRIVE_API_PREFIX, DRIVE_API_RE }

const IMAGE_FOLDER = 'PGHubTechImages'

export function getOrCreateImageFolder(token: string): Promise<string> {
  return getOrCreateFolder(token, IMAGE_FOLDER)
}

// Multipart-upload an image and return the authenticated media URL. Kept for
// callers that only need the URL; if you need the file ID too, use
// uploadFileToDrive() from lib/drive.ts directly.
export async function uploadImageBlob(
  token:    string,
  folderId: string,
  blob:     Blob,
  filename: string,
): Promise<string> {
  const { url } = await uploadFileToDrive(token, folderId, blob, filename, 'image/png')
  return url
}

export function inferFilename(blob: Blob): string {
  const subtype = (blob.type.split('/')[1] || 'png').replace('+xml', '')
  const stamp   = Date.now().toString(36)
  const rand    = Math.random().toString(36).slice(2, 6)
  return `paste_${stamp}_${rand}.${subtype}`
}

// Walk an HTML string and upload every <img> whose src is data:image/… or
// blob:… to Drive, returning rewritten HTML with Drive URLs. Throws if any
// image cannot be fetched (e.g. a blob: URL minted in another document).
export async function uploadInlineImages(html: string, token: string): Promise<string> {
  if (!/<img[^>]+src="(?:data:image\/|blob:)/i.test(html)) return html
  const folderId  = await getOrCreateImageFolder(token)
  const container = document.createElement('div')
  container.innerHTML = html
  const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[]
  const failed: string[] = []
  for (const img of imgs) {
    const src = img.getAttribute('src') || ''
    if (!src.startsWith('data:image/') && !src.startsWith('blob:')) continue
    try {
      const blob = await (await fetch(src)).blob()
      if (!blob.size) throw new Error('empty')
      const url = await uploadImageBlob(token, folderId, blob, inferFilename(blob))
      img.setAttribute('src', url)
    } catch (e) {
      failed.push((e as Error).message)
    }
  }
  if (failed.length) {
    throw new Error(
      `${failed.length} image${failed.length === 1 ? '' : 's'} could not be uploaded ` +
      `(${failed[0]}). Try re-pasting the image directly.`
    )
  }
  return container.innerHTML
}
