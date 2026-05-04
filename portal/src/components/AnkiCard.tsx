import { useState } from 'react'
import type { AnkiNote, AnkiTemplate } from '../adapters/ankiRepo'
import type { Rating } from '../adapters/srsRepo'

interface BrowseProps {
  note: AnkiNote
  template: AnkiTemplate
  mode?: 'browse'
}

interface PracticeProps {
  note: AnkiNote
  template: AnkiTemplate
  mode: 'practice'
  flipped: boolean
  onFlip: () => void
  onRate: (r: Rating) => void
}

type Props = BrowseProps | PracticeProps

function FieldContent({ type, value }: { type: string; value: string }) {
  if (!value) return null
  if (type === 'html') {
    return <div className="ak-html" dangerouslySetInnerHTML={{ __html: value }} />
  }
  return <p className="ak-text">{value}</p>
}

const RATINGS: { r: Rating; label: string; cls: string }[] = [
  { r: 0, label: 'Again', cls: 'ak-again' },
  { r: 1, label: 'Hard',  cls: 'ak-hard'  },
  { r: 2, label: 'Good',  cls: 'ak-good'  },
  { r: 3, label: 'Easy',  cls: 'ak-easy'  },
]

export default function AnkiCard(props: Props) {
  const { note, template } = props
  const [localFlipped, setLocalFlipped] = useState(false)

  const flipped    = props.mode === 'practice' ? props.flipped    : localFlipped
  const handleFlip = props.mode === 'practice' ? props.onFlip     : () => setLocalFlipped(f => !f)

  const frontFields = template.fields.filter(f => f.isFront)
  const backFields  = template.fields.filter(f => f.isBack && !f.isFront)
  const extraFields = template.fields.filter(f => !f.isFront && !f.isBack)
    .filter(f => note.fields[f.key])

  const isPractice = props.mode === 'practice'

  return (
    <div className={`ak-wrap${isPractice ? ' ak-practice' : ''}`}>
      {/* Card flip scene */}
      <div
        className={`ak-scene${flipped ? ' flipped' : ''}`}
        onClick={!isPractice ? handleFlip : undefined}
        role={!isPractice ? 'button' : undefined}
        tabIndex={!isPractice ? 0 : undefined}
        onKeyDown={!isPractice ? e => e.key === 'Enter' && handleFlip() : undefined}
      >
        {/* Front face */}
        <div className="ak-face ak-front">
          <div className="ak-face-body">
            {frontFields.map(f => (
              <div key={f.key} className="ak-section">
                {frontFields.length > 1 && <div className="ak-field-label">{f.label}</div>}
                <FieldContent type={f.type} value={note.fields[f.key] ?? ''} />
              </div>
            ))}
          </div>
          {!isPractice && <div className="ak-hint-bar">click to reveal</div>}
          <TagRow tags={note.tags} />
        </div>

        {/* Back face */}
        <div className="ak-face ak-back">
          <div className="ak-face-body">
            {frontFields.map(f => (
              <div key={f.key} className="ak-section ak-front-repeat">
                <FieldContent type={f.type} value={note.fields[f.key] ?? ''} />
              </div>
            ))}
            {backFields.length > 0 && <div className="ak-hr" />}
            {backFields.map(f => (
              <div key={f.key} className="ak-section">
                {backFields.length > 1 && <div className="ak-field-label">{f.label}</div>}
                <FieldContent type={f.type} value={note.fields[f.key] ?? ''} />
              </div>
            ))}
            {extraFields.length > 0 && (
              <div className="ak-extra">
                {extraFields.map(f => (
                  <div key={f.key} className="ak-extra-row">
                    <span className="ak-extra-label">{f.label}</span>
                    <FieldContent type={f.type} value={note.fields[f.key] ?? ''} />
                  </div>
                ))}
              </div>
            )}
          </div>
          <TagRow tags={note.tags} deck={note.deck} />
        </div>
      </div>

      {/* Practice controls */}
      {isPractice && !flipped && (
        <button className="ak-show-btn" onClick={handleFlip}>Show Answer</button>
      )}
      {isPractice && flipped && (
        <div className="ak-ratings">
          {RATINGS.map(({ r, label, cls }) => (
            <button key={r} className={`ak-rate-btn ${cls}`} onClick={() => props.onRate(r)}>
              {label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function TagRow({ tags, deck }: { tags: string[]; deck?: string }) {
  if (!tags.length && !deck) return null
  return (
    <div className="ak-tag-row">
      {deck && <span className="ak-deck-chip">{deck.split('::').pop()}</span>}
      {tags.slice(0, 4).map(t => (
        <span key={t} className="tag-chip">{t.split('::').pop()}</span>
      ))}
    </div>
  )
}
