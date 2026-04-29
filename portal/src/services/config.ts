const P = 'pghtech_'
const DEFAULT_CLIENT_ID = '650455977557-q0tunhbtfb2qabnhts5q6dac47b2q3iq.apps.googleusercontent.com'

export const Config = {
  get googleClientId(): string {
    return localStorage.getItem(P + 'gci') || (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '') || DEFAULT_CLIENT_ID
  },
  get sheetId(): string {
    return localStorage.getItem(P + 'sid') || (import.meta.env.VITE_SHEET_ID ?? '')
  },
  get theme(): string { return localStorage.getItem(P + 'theme') || 'dark' },
  get allowedEmails(): string[] {
    const raw = import.meta.env.VITE_ALLOWED_EMAILS ?? ''
    return raw.split(',').map((e: string) => e.trim()).filter(Boolean)
  },

  set googleClientId(v: string) { localStorage.setItem(P + 'gci', v) },
  set sheetId(v: string) { localStorage.setItem(P + 'sid', v) },
  set theme(v: string) { localStorage.setItem(P + 'theme', v) },

  clearSheetId() { localStorage.removeItem(P + 'sid') },
  isClientConfigured(): boolean { return !!this.googleClientId },
  isSheetConfigured(): boolean  { return !!this.sheetId },
}
