// Journal — the day written up, then read back.
//
// One entry per date. A dictated account is cleaned and pulled apart into a
// timeline banded by time of day plus the day's reflection, all stored in the
// Journal tab of the DART spreadsheet. The calendar answers consistency; the
// Patterns tab consolidates what keeps being fixed and what worked; Insights
// are generated on demand over a window and kept so they can be re-read.

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  addInsight, dartConfig, deleteInsight, deleteJournal,
  loadDartConfig, loadInsights, loadJournal, saveJournal,
} from '../adapters/dartRepo'
import type { DartConfig, JournalEntry, JournalInsight } from '../adapters/dartRepo'
import { fmtMins, isoDate, parseIso } from '../lib/dartPlan'
import { bareJournal, consolidate, extractJournal, generateInsights } from '../lib/journalGen'
import JournalCalendar, { WINDOWS } from '../components/JournalCalendar'
import { useToast } from '../components/Toast'
import { LLM } from '../lib/llm'
import { sanitizeHtml } from '../lib/sanitize'

const DAY_NAMES   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']
const MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

type Tab = 'day' | 'patterns' | 'insights'

export default function JournalView() {
  const { toast } = useToast()
  const [entries, setEntries]   = useState<JournalEntry[]>([])
  const [insights, setInsights] = useState<JournalInsight[]>([])
  const [cfg, setCfg]           = useState<DartConfig>(dartConfig())
  const [loading, setLoading]   = useState(true)
  const [tab, setTab]           = useState<Tab>('day')
  const [date, setDate]         = useState(() => isoDate(new Date()))
  const [draft, setDraft]       = useState('')
  const [saving, setSaving]     = useState(false)
  const [stage, setStage]       = useState('')
  const [rawOpen, setRawOpen]   = useState(false)
  const [origOpen, setOrigOpen] = useState(false)
  const [winKey, setWinKey]     = useState('30d')
  const [range, setRange]       = useState({ from: '', to: '' })
  const [genBusy, setGenBusy]   = useState(false)
  const [openInsight, setOpenInsight] = useState<string | null>(null)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    loadDartConfig().then(setCfg).catch(() => { /* defaults stand */ })
    Promise.all([loadJournal(), loadInsights()])
      .then(([js, is]) => { setEntries(js); setInsights(is); setLoading(false) })
      .catch(e => { setLoading(false); toast(`Load failed: ${(e as Error).message}`, 'error') })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const byDate = useMemo(() => new Map(entries.map(e => [e.date, e])), [entries])
  const dates  = useMemo(() => new Set(entries.map(e => e.date)), [entries])
  const entry  = byDate.get(date) ?? null

  // Editing a day loads what is already there; a fresh day starts empty.
  useEffect(() => {
    setDraft(''); setRawOpen(false); setOrigOpen(false)
  }, [date])

  async function save() {
    const raw = draft.trim()
    if (!raw || saving) return
    setSaving(true)
    try {
      let fields = bareJournal(raw, date)
      if (LLM.isConfigured()) {
        setStage('Cleaning up and reading the day…')
        const got = await extractJournal(raw, date).catch(e => {
          toast(`Saved, but extraction failed: ${(e as Error).message}`, 'error'); return null
        })
        if (got) fields = got
      } else {
        toast('Saved unprocessed — add the Azure key in Settings to structure the day.', 'info')
      }
      const saved = await saveJournal(fields)
      setEntries(prev => {
        const rest = prev.filter(e => e.date !== saved.date)
        return [saved, ...rest].sort((a, b) => b.date.localeCompare(a.date))
      })
      setDraft('')
    } catch (e) {
      toast(`Save failed: ${(e as Error).message}`, 'error')
    } finally { setSaving(false); setStage('') }
  }

  async function removeEntry(e: JournalEntry) {
    if (!window.confirm(`Delete the journal for ${e.date}? The original capture goes with it.`)) return
    try {
      await deleteJournal(e.id)
      setEntries(prev => prev.filter(x => x.id !== e.id))
    } catch (err) { toast(`Delete failed: ${(err as Error).message}`, 'error') }
  }

  const inWindow = useMemo(
    () => entries.filter(e => (!range.from || e.date >= range.from) && (!range.to || e.date <= range.to)),
    [entries, range])

  async function makeInsight() {
    if (genBusy) return
    setGenBusy(true)
    try {
      const rich = await generateInsights({ from: range.from, to: range.to, entries: inWindow })
      const created = await addInsight({
        fromDate: range.from, toDate: range.to,
        label: WINDOWS.find(w => w.key === winKey)?.label ?? winKey,
        daysCovered: inWindow.length, rich,
      })
      setInsights(prev => [created, ...prev])
      setOpenInsight(created.id)
      setTab('insights')
    } catch (e) {
      toast(`Could not generate: ${(e as Error).message}`, 'error')
    } finally { setGenBusy(false) }
  }

  async function removeInsight(i: JournalInsight) {
    if (!window.confirm('Delete this generated report?')) return
    try {
      await deleteInsight(i.id)
      setInsights(prev => prev.filter(x => x.id !== i.id))
    } catch (e) { toast(`Delete failed: ${(e as Error).message}`, 'error') }
  }

  const fixing = useMemo(() => consolidate(entries, e => e.fixing), [entries])
  const worked = useMemo(() => consolidate(entries, e => e.worked), [entries])
  const wrong  = useMemo(() => consolidate(entries, e => e.wentWrong), [entries])

  const d = parseIso(date)
  const todayIso = isoDate(new Date())

  return (
    <div className="dart-thoughts-wrap jr-wrap">
      <aside className="jr-side">
        <JournalCalendar
          dates={dates} selected={date} onSelect={setDate}
          windowKey={winKey} onWindow={setWinKey}
          onRangeChange={(from, to) => setRange({ from, to })}
        />
      </aside>

      <div className="dart-body jr-main">
        <div className="activity-subtabs jr-tabs">
          <button className={`activity-subtab${tab === 'day' ? ' active' : ''}`}
                  onClick={() => setTab('day')}>📓 The day</button>
          <button className={`activity-subtab${tab === 'patterns' ? ' active' : ''}`}
                  onClick={() => setTab('patterns')}>🔁 Patterns</button>
          <button className={`activity-subtab${tab === 'insights' ? ' active' : ''}`}
                  onClick={() => setTab('insights')}>✨ Insights</button>
        </div>

        {loading ? <div className="col-empty">Loading…</div>
         : tab === 'day' ? (
          <>
            <div className="jr-dayhead">
              <button className="dart-navbtn" onClick={() => { const n = parseIso(date); n.setDate(n.getDate() - 1); setDate(isoDate(n)) }}>‹</button>
              <div className="dart-daytitle">
                <div className="dart-dayname">{DAY_NAMES[d.getDay()]}</div>
                <div className="dart-daydate">{MONTH_NAMES[d.getMonth()]} {d.getDate()}</div>
              </div>
              <button className="dart-navbtn" onClick={() => { const n = parseIso(date); n.setDate(n.getDate() + 1); setDate(isoDate(n)) }}>›</button>
              {date !== todayIso && <button className="dart-todaybtn" onClick={() => setDate(todayIso)}>Today</button>}
              {entry && <span className="jr-saved">saved</span>}
            </div>

            <div className="dart-composer">
              <textarea
                ref={boxRef} className="dart-composer-box" rows={entry ? 3 : 5} value={draft}
                placeholder={entry
                  ? 'Add to this day, or rewrite it — saving replaces the entry for this date.'
                  : 'How did the day go? Speak or type it raw — wake and sleep times, what you did and when, what went right and wrong.'}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }}
              />
              <div className="dart-composer-foot">
                <span className="dart-hint">
                  {saving && stage ? stage : '⌘/Ctrl + Enter · one entry per day · your original capture is kept'}
                </span>
                <button className="mgmt-save-btn" disabled={!draft.trim() || saving} onClick={save}>
                  {saving ? 'Reading the day…' : entry ? 'Replace entry' : 'Save day'}
                </button>
              </div>
            </div>

            {entry ? (
              <DayView
                e={entry} cfg={cfg}
                rawOpen={rawOpen} origOpen={origOpen}
                onToggleRaw={() => setRawOpen(o => !o)}
                onToggleOrig={() => setOrigOpen(o => !o)}
                onDelete={() => removeEntry(entry)}
              />
            ) : (
              <div className="col-empty">Nothing written for this day yet.</div>
            )}
          </>
        ) : tab === 'patterns' ? (
          <div className="jr-patterns">
            <p className="dart-hint">
              Rolled up across every entry — the same item written the same way on
              different days counts as one recurring thing.
            </p>
            <PatternList
              title="Trying to fix" tone="warn" items={fixing}
              empty="Nothing recorded yet as something you're working on." />
            <PatternList
              title="What worked" tone="good" items={worked}
              empty="No habit or strategy has been marked as working yet." />
            <PatternList
              title="What went wrong" tone="warn" items={wrong}
              empty="No recurring problems recorded." />
          </div>
        ) : (
          <div className="jr-insights">
            <div className="jr-gen">
              <div className="jr-gen-hd">
                <span className="dart-section-title">✨ Generate a report</span>
                <span className="dart-section-meta">
                  {range.from} → {range.to} · <b>{inWindow.length}</b> entries
                </span>
              </div>
              <p className="dart-hint">
                Reads the entries in the calendar's current window and reports what keeps
                failing, the 1% change that would move it, and strategies that worked and
                were dropped. Generated on demand and kept, so a report can be re-read.
              </p>
              <button
                className="mgmt-save-btn" disabled={genBusy || inWindow.length === 0}
                onClick={makeInsight}
              >{genBusy ? 'Reading the window…' : `Generate from ${inWindow.length} entries`}</button>
            </div>

            {insights.length === 0 ? (
              <div className="col-empty">No reports yet.</div>
            ) : (
              <ul className="jr-insight-list">
                {insights.map(i => (
                  <li className="jr-insight" key={i.id}>
                    <div className="jr-insight-hd">
                      <button className="jr-insight-open"
                              onClick={() => setOpenInsight(o => o === i.id ? null : i.id)}>
                        <span className="jr-insight-when">{i.createdAt.slice(0, 10)}</span>
                        <span className="jr-insight-label">{i.label}</span>
                        <span className="jr-insight-range">{i.fromDate} → {i.toDate}</span>
                        <span className="tt-count">{i.daysCovered} days</span>
                      </button>
                      <button className="dart-minibtn danger" onClick={() => removeInsight(i)}>✕</button>
                    </div>
                    {openInsight === i.id && (
                      <div className="th-rich" dangerouslySetInnerHTML={{ __html: sanitizeHtml(i.rich) }} />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PatternList({ title, tone, items, empty }: {
  title: string; tone: 'good' | 'warn'
  items: { text: string; days: string[] }[]; empty: string
}) {
  return (
    <section className="dart-section">
      <div className="dart-section-hd">
        <span className="dart-section-title">{title}</span>
        <span className="dart-section-meta">{items.length}</span>
      </div>
      {items.length === 0 ? <div className="col-empty">{empty}</div> : (
        <ul className="jr-pattern-list">
          {items.map(it => (
            <li className={`jr-pattern t-${tone}`} key={it.text}>
              <span className="jr-pattern-n">{it.days.length}</span>
              <span className="jr-pattern-body">
                <span className="jr-pattern-text">{it.text}</span>
                <span className="jr-pattern-days">
                  {it.days.slice(0, 6).join(' · ')}{it.days.length > 6 ? ` +${it.days.length - 6}` : ''}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function DayView({ e, cfg, rawOpen, origOpen, onToggleRaw, onToggleOrig, onDelete }: {
  e: JournalEntry; cfg: DartConfig
  rawOpen: boolean; origOpen: boolean
  onToggleRaw: () => void; onToggleOrig: () => void; onDelete: () => void
}) {
  const total = e.timeline.reduce((s, t) => s + t.minutes, 0)
  return (
    <div className="jr-day">
      <div className="jr-day-bar">
        {e.wakeTime && <span className="jr-chip"><b>{e.wakeTime}</b> woke</span>}
        {e.sleepTime && <span className="jr-chip"><b>{e.sleepTime}</b> slept</span>}
        {total > 0 && <span className="jr-chip"><b>{fmtMins(total)}</b> accounted</span>}
        <span className="dart-thought-spacer" />
        <button className="dart-minibtn" onClick={onToggleRaw}>{rawOpen ? 'Hide Raw Text' : 'Raw Text'}</button>
        <button className="dart-minibtn danger" onClick={onDelete}>✕</button>
      </div>

      {e.summary && <div className="dart-thought-summary">{e.summary}</div>}

      {/* The day by band. Empty bands are shown too — a blank afternoon is
          itself the finding when you re-read a week. */}
      <div className="jr-bands">
        {cfg.dayBands.map(b => {
          const items = e.timeline.filter(t => t.band === b.key)
          const mins  = items.reduce((s, t) => s + t.minutes, 0)
          return (
            <div className={`jr-band${items.length === 0 ? ' empty' : ''}`} key={b.key}>
              <div className="jr-band-hd">
                <span className="jr-band-name">{b.label}</span>
                <span className="jr-band-hint">{b.hint}</span>
                {mins > 0 && <span className="jr-band-mins">{fmtMins(mins)}</span>}
              </div>
              {items.length === 0 ? (
                <div className="jr-band-empty">—</div>
              ) : (
                <ul className="jr-band-list">
                  {items.map((t, i) => (
                    <li key={i}>
                      {(t.from || t.to) && (
                        <span className="jr-time">{t.from}{t.to ? `–${t.to}` : ''}</span>
                      )}
                      <span className="jr-band-title">{t.title}</span>
                      {t.minutes > 0 && <span className="jr-band-mins">{fmtMins(t.minutes)}</span>}
                      {t.detail && <span className="jr-band-detail">{t.detail}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      {(e.expected || e.reality) && (
        <div className="jr-vs">
          <div className="jr-vs-col"><h4>Expected</h4><p>{e.expected || '—'}</p></div>
          <div className="jr-vs-arrow">→</div>
          <div className="jr-vs-col"><h4>Reality</h4><p>{e.reality || '—'}</p></div>
        </div>
      )}

      <div className="jr-refl">
        <ReflBlock title="Went right" tone="good" items={e.wentRight} />
        <ReflBlock title="Went wrong" tone="warn" items={e.wentWrong} />
        <ReflBlock title="Trying to fix" tone="warn" items={e.fixing} />
        <ReflBlock title="What worked" tone="good" items={e.worked} />
      </div>

      {rawOpen && (
        <div className="th-raw-wrap">
          <div className="th-raw-hd">
            <span>Cleaned capture</span>
            {e.rawOriginal && e.rawOriginal !== e.raw && (
              <button className="dart-minibtn" onClick={onToggleOrig}>
                {origOpen ? 'Hide original' : 'Show original'}
              </button>
            )}
          </div>
          <pre className="dart-thought-raw">{e.raw}</pre>
          {origOpen && (
            <>
              <div className="th-raw-hd"><span>Original, exactly as captured</span></div>
              <pre className="dart-thought-raw original">{e.rawOriginal}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ReflBlock({ title, tone, items }: { title: string; tone: 'good' | 'warn'; items: string[] }) {
  if (items.length === 0) return null
  return (
    <div className={`jr-refl-block t-${tone}`}>
      <h4>{title}</h4>
      <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul>
    </div>
  )
}
