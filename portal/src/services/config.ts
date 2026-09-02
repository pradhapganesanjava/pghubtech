const P = 'pghtech_'
const DEFAULT_CLIENT_ID = '650455977557-q0tunhbtfb2qabnhts5q6dac47b2q3iq.apps.googleusercontent.com'

// localStorage helpers — used both for explicit user prefs and for caching
// values fetched from the Sheet's Settings tab so they're available before the
// async sheet fetch completes on subsequent loads.
function ls(k: string): string | null { return localStorage.getItem(P + k) }
function lsSet(k: string, v: string)   { localStorage.setItem(P + k, v) }
function lsDel(k: string)              { localStorage.removeItem(P + k) }

const ENV = {
  azureEndpoint:    (import.meta.env.VITE_AZURE_ENDPOINT      ?? '') as string,
  azureDeployment:  (import.meta.env.VITE_AZURE_DEPLOYMENT    ?? 'gpt-4o') as string,
  azureApiVersion:  (import.meta.env.VITE_AZURE_API_VERSION   ?? '2024-12-01-preview') as string,
  azureApiKey:      (import.meta.env.VITE_AZURE_API_KEY       ?? '') as string,
  azureTtsEndpoint: (import.meta.env.VITE_AZURE_TTS_ENDPOINT  ?? '') as string,
  azureTtsApiKey:   (import.meta.env.VITE_AZURE_TTS_API_KEY   ?? '') as string,
  azureTtsDeploy:   (import.meta.env.VITE_AZURE_TTS_DEPLOY    ?? '') as string,
  azureTtsVersion:  (import.meta.env.VITE_AZURE_TTS_VERSION   ?? '2025-03-01-preview') as string,
  ttsVoice:         (import.meta.env.VITE_TTS_VOICE           ?? 'nova') as string,
}

export const Config = {
  get googleClientId(): string {
    return ls('gci') || (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '') || DEFAULT_CLIENT_ID
  },
  get sheetId(): string {
    return ls('sid') || (import.meta.env.VITE_SHEET_ID ?? '')
  },
  // DART keeps its own spreadsheet inside the Drive folder PGHubTechDART.
  // Cached here so day-to-day loads skip the Drive folder+file lookup; it is
  // re-resolved automatically whenever this is empty.
  get dartSheetId(): string { return ls('dartsid') || '' },
  get theme(): string { return ls('theme') || 'dark' },
  get allowedEmails(): string[] {
    const raw = import.meta.env.VITE_ALLOWED_EMAILS ?? ''
    return raw.split(',').map((e: string) => e.trim()).filter(Boolean)
  },

  set googleClientId(v: string) { lsSet('gci', v) },
  set sheetId(v: string)        { lsSet('sid', v) },
  set dartSheetId(v: string)    { v ? lsSet('dartsid', v) : lsDel('dartsid') },
  set theme(v: string)          { lsSet('theme', v) },

  // ── AI assistant — persisted to Sheet (Settings tab) AND mirrored to
  //    localStorage so getters return synchronously on every page load.
  get azureEndpoint()      { return ls('aze')    ?? ENV.azureEndpoint },
  get azureDeployment()    { return ls('azd')    ?? ENV.azureDeployment },
  get azureApiVersion()    { return ls('azv')    ?? ENV.azureApiVersion },
  get azureApiKey()        { return ls('azk')    ?? ENV.azureApiKey },
  get azureTtsEndpoint()   { return ls('aztep')  ?? ENV.azureTtsEndpoint },
  get azureTtsApiKey()     { return ls('aztak')  ?? ENV.azureTtsApiKey },
  get azureTtsDeployment() { return ls('aztts')  ?? ENV.azureTtsDeploy },
  get azureTtsApiVersion() { return ls('azttsv') ?? ENV.azureTtsVersion },
  get ttsVoice()           { return ls('ttsv')   ?? ENV.ttsVoice },
  get audioOn()            { return ls('audio')  !== 'false' },

  set azureEndpoint(v: string)      { v ? lsSet('aze',    v) : lsDel('aze') },
  set azureDeployment(v: string)    { v ? lsSet('azd',    v) : lsDel('azd') },
  set azureApiVersion(v: string)    { v ? lsSet('azv',    v) : lsDel('azv') },
  set azureApiKey(v: string)        { v ? lsSet('azk',    v) : lsDel('azk') },
  set azureTtsEndpoint(v: string)   { v ? lsSet('aztep',  v) : lsDel('aztep') },
  set azureTtsApiKey(v: string)     { v ? lsSet('aztak',  v) : lsDel('aztak') },
  set azureTtsDeployment(v: string) { v ? lsSet('aztts',  v) : lsDel('aztts') },
  set azureTtsApiVersion(v: string) { v ? lsSet('azttsv', v) : lsDel('azttsv') },
  set ttsVoice(v: string)           { v ? lsSet('ttsv',   v) : lsDel('ttsv') },
  set audioOn(v: boolean)           { lsSet('audio', String(v)) },

  clearSheetId() { lsDel('sid'); lsDel('dartsid') },
  isClientConfigured(): boolean { return !!this.googleClientId },
  isSheetConfigured(): boolean  { return !!this.sheetId },
  isAIConfigured(): boolean     { return !!(this.azureEndpoint && this.azureApiKey) },
}
