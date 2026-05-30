// Tiny localStorage-backed filter-state persistence.
//
// Each view (Home / Browse / AdsHub) keeps its applied filters under a unique
// key so they reload on the next visit — and survive logout/login because
// localStorage isn't tied to the OAuth session. ClearAll naturally resets
// the saved state too: it sets the in-memory filters to empty defaults, and
// the persistence effect immediately writes those empties back over the key.

export function loadFilters<T>(key: string, defaults: T): T {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return defaults
    const parsed = JSON.parse(raw)
    // Merge with defaults so adding a new filter field later doesn't break
    // sessions that have an older payload cached.
    return { ...defaults, ...parsed }
  } catch {
    return defaults
  }
}

export function saveFilters<T>(key: string, state: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(state))
  } catch { /* quota / disabled storage — silently ignore */ }
}
