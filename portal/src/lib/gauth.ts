// Google Identity Services — OAuth 2.0 token flow
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const google: any

const SESSION_KEY = 'pghtech_tok'
const USER_KEY    = 'pghtech_usr'

export interface GoogleUser {
  id:      string
  email:   string
  name:    string
  picture: string
}

interface StoredToken {
  token:   string
  expires: number
}

export const GAuth = {
  _token: null as string | null,
  _user:  null as GoogleUser | null,

  restoreSession(): boolean {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return false
    try {
      const { token, expires } = JSON.parse(raw) as StoredToken
      if (Date.now() < expires - 5 * 60 * 1000) {  // reject if < 5 min remaining
        this._token = token
        const userRaw = sessionStorage.getItem(USER_KEY)
        if (userRaw) this._user = JSON.parse(userRaw) as GoogleUser
        return true
      }
    } catch { /* expired or corrupt */ }
    return false
  },

  getToken(): string | null { return this._token },
  getUser(): GoogleUser | null  { return this._user },
  isSignedIn(): boolean { return !!this._token },

  signIn(clientId: string): Promise<GoogleUser> {
    return new Promise((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const client = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        scope: [
          'https://www.googleapis.com/auth/spreadsheets',
          'https://www.googleapis.com/auth/drive.metadata.readonly',
          'https://www.googleapis.com/auth/drive.file',
          'https://www.googleapis.com/auth/userinfo.profile',
          'https://www.googleapis.com/auth/userinfo.email',
        ].join(' '),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        callback: async (res: any) => {
          if (res.error) { reject(new Error(res.error as string)); return }

          this._token = res.access_token as string
          const expires = Date.now() + (res.expires_in as number) * 1000
          sessionStorage.setItem(SESSION_KEY, JSON.stringify({ token: this._token, expires }))

          try {
            const r = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
              headers: { Authorization: `Bearer ${this._token}` },
            })
            this._user = (await r.json()) as GoogleUser
            sessionStorage.setItem(USER_KEY, JSON.stringify(this._user))
          } catch { /* profile fetch failed — continue without it */ }

          resolve(this._user!)
        },
      })
      client.requestAccessToken({ prompt: '' })
    })
  },

  signOut() {
    if (this._token) {
      try { google.accounts.oauth2.revoke(this._token) } catch { /* ignore */ }
    }
    this._token = null
    this._user  = null
    sessionStorage.removeItem(SESSION_KEY)
    sessionStorage.removeItem(USER_KEY)
  },

  // List user's Google Sheets from Drive for the sheet picker
  async listSheets(): Promise<{ id: string; name: string }[]> {
    if (!this._token) return []
    try {
      const url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
        "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false"
      )}&fields=files(id,name)&orderBy=modifiedTime+desc&pageSize=20`
      const r = await fetch(url, { headers: { Authorization: `Bearer ${this._token}` } })
      if (!r.ok) return []
      const data = await r.json() as { files: { id: string; name: string }[] }
      return data.files || []
    } catch { return [] }
  },

  // Create a new Google Sheet and return its ID
  async createSheet(title: string): Promise<string> {
    if (!this._token) throw new Error('Not authenticated')
    const r = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this._token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ properties: { title } }),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({})) as { error?: { message?: string } }
      throw new Error(err?.error?.message ?? `HTTP ${r.status}`)
    }
    const data = await r.json() as { spreadsheetId: string }
    return data.spreadsheetId
  },
}
