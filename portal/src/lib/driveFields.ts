// Offload oversized Anki field values to Drive so they fit Google Sheets'
// hard 50,000-characters-per-cell cap.
//
// A field whose value exceeds the cap is uploaded to a small Drive HTML file
// and the sheet cell stores a tiny pointer (PGHUB_FIELD_REF::<fileId>) instead
// of the content. On load the pointer is resolved back to the full content, so
// the rest of the app (editors, review flow, CSV export) never sees the
// indirection. Mirrors the existing inline-image offload in driveImages.ts.

import {
  getOrCreateFolder, uploadFileToDrive, updateDriveFileContent,
  fetchDriveFile, deleteDriveFile,
} from './drive'

const FIELD_FOLDER = 'PGHubTechFields'

// Offload anything above this. Kept well below the 50,000 hard cap to leave
// headroom for the pointer itself and any surrogate-pair miscounting (cell
// limit is code points; String.length counts UTF-16 units, so we're already
// conservative — this is extra margin).
export const FIELD_OFFLOAD_THRESHOLD = 45_000

const REF_PREFIX = 'PGHUB_FIELD_REF::'

export function isFieldRef(value: string): boolean {
  return value.startsWith(REF_PREFIX)
}

function refFileId(value: string): string {
  return value.slice(REF_PREFIX.length)
}

function fieldFolder(token: string): Promise<string> {
  return getOrCreateFolder(token, FIELD_FOLDER)
}

function fieldFilename(): string {
  const stamp = Date.now().toString(36)
  const rand  = Math.random().toString(36).slice(2, 6)
  return `field_${stamp}_${rand}.html`
}

// Decide how a (possibly new) field value should be stored in its cell, given
// what the cell held before. Returns the cell-safe string to write:
//   • value fits     → the value itself; if the previous cell was a Drive
//                       pointer, that now-orphaned file is deleted.
//   • value too big  → a pointer string; the previous Drive file is reused
//                       (updated in place, same id) when one exists, else a
//                       new file is created.
export async function reconcileField(
  newValue:  string,
  prevValue: string,
  token:     string,
): Promise<string> {
  const prevId = isFieldRef(prevValue) ? refFileId(prevValue) : null

  if (newValue.length > FIELD_OFFLOAD_THRESHOLD) {
    const blob = new Blob([newValue], { type: 'text/html' })
    if (prevId) {
      await updateDriveFileContent(token, prevId, blob)
      return prevValue            // same pointer, contents updated in place
    }
    const folderId = await fieldFolder(token)
    const { id } = await uploadFileToDrive(token, folderId, blob, fieldFilename(), 'text/html')
    return REF_PREFIX + id
  }

  // Value now fits inline — drop any previously-offloaded file (best-effort).
  if (prevId) { try { await deleteDriveFile(token, prevId) } catch { /* leak rather than fail the save */ } }
  return newValue
}

// Resolve a cell value for display/use: fetch the full content from Drive if
// it's a pointer, otherwise return it unchanged.
export async function resolveField(value: string, token: string): Promise<string> {
  if (!isFieldRef(value)) return value
  const blob = await fetchDriveFile(token, refFileId(value))
  return blob.text()
}

// Delete the Drive file backing a pointer cell (best-effort). Used when a note
// row is removed so its offloaded field files don't linger.
export async function deleteFieldRef(value: string, token: string): Promise<void> {
  if (!isFieldRef(value)) return
  try { await deleteDriveFile(token, refFileId(value)) } catch { /* best-effort */ }
}
