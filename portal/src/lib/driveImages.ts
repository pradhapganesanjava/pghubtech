// Image-specific Drive helpers built on top of the generic lib/drive.ts
// primitives. Used by the rich-text editor's paste handler and the
// handwriting-note uploader.

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

// Multipart-upload an image and return the authenticated media URL. Used by
// the handwriting-note uploader, which stores exported page PNGs on Drive.
//
// NOTE: pasted images are NOT uploaded here — they are kept inline as base64
// data: URIs (see blobToDataUri / inlineImagesToDataUri) so they stay portable
// outside the portal. A Drive media URL (…/files/{id}?alt=media) only loads
// through an authenticated request, so it 403s wherever the portal's OAuth
// token is absent (e.g. a card copied into Anki).
export async function uploadImageBlob(
  token:    string,
  folderId: string,
  blob:     Blob,
  filename: string,
): Promise<string> {
  const { url } = await uploadFileToDrive(token, folderId, blob, filename, 'image/png')
  return url
}

// Read a blob as a base64 data: URI. This is how pasted images are stored:
// self-contained in the field HTML, so they load with no token and no network
// and survive being copied out of the portal (Anki, email, offline). Oversized
// fields still fit the sheet — driveFields.ts offloads any cell past the 50k
// cap to a Drive HTML file transparently.
export function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload  = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('could not read image'))
    reader.readAsDataURL(blob)
  })
}

// Walk an HTML string and inline every <img> whose src is a transient blob:
// URL, converting it to a self-contained data: URI. data:image/… srcs are
// already inline and pass through untouched; http(s)/Drive URLs are left as-is.
// Throws if any blob: image cannot be read (e.g. a blob minted in another
// document) so we never silently store an unloadable URL.
export async function inlineImagesToDataUri(html: string): Promise<string> {
  if (!/<img[^>]+src="blob:/i.test(html)) return html
  const container = document.createElement('div')
  container.innerHTML = html
  const imgs = Array.from(container.querySelectorAll('img')) as HTMLImageElement[]
  const failed: string[] = []
  for (const img of imgs) {
    const src = img.getAttribute('src') || ''
    if (!src.startsWith('blob:')) continue
    try {
      const blob = await (await fetch(src)).blob()
      if (!blob.size) throw new Error('empty')
      img.setAttribute('src', await blobToDataUri(blob))
    } catch (e) {
      failed.push((e as Error).message)
    }
  }
  if (failed.length) {
    throw new Error(
      `${failed.length} image${failed.length === 1 ? '' : 's'} could not be inlined ` +
      `(${failed[0]}). Try re-pasting the image directly.`
    )
  }
  return container.innerHTML
}
