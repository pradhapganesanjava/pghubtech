// Ask the LLM to populate ALL fields of a chosen template from a free-text
// prompt. Used by the "Add Note" modal so the user can describe what they
// want studied and have the Front / Back / extras filled in automatically.
//
// The model is told the template's exact field schema (key, label, hints,
// front/back role) and returns strict JSON keyed by field key, so the
// caller can drop the result straight into form state.

import type { AnkiField, AnkiTemplate } from '../adapters/ankiRepo'
import { LLM } from './llm'
import { parseLooseJson } from './looseJson'

export interface AnkiNoteDraft {
  fields: Record<string, string>
  tags:   string[]
}

function fieldSpec(f: AnkiField): string {
  const role = f.isFront ? 'FRONT' : f.isBack ? 'BACK' : 'EXTRA'
  const hint =
    f.type === 'select' && f.options
      ? `enum (one of: ${f.options})`
      : f.type === 'html' || f.isFront || f.isBack
        ? 'HTML allowed (use <code>, <ul>, <strong>, <br>, etc. — short, well-formed)'
        : 'plain text'
  return `  - "${f.key}" (${f.label}) — role=${role}, ${hint}`
}

function buildSystemPrompt(tpl: AnkiTemplate): string {
  const sortedFields = [...tpl.fields].sort((a, b) => a.order - b.order)
  const fieldsBlock  = sortedFields.map(fieldSpec).join('\n')
  const schemaKeys   = sortedFields.map(f => `    "${f.key}": "…"`).join(',\n')
  return [
    `You generate a single spaced-repetition flashcard for the Anki-style template "${tpl.displayName}".`,
    `Output STRICT JSON ONLY — no prose, no markdown fences, no commentary. First character "{", last character "}".`,
    ``,
    `Template fields:`,
    fieldsBlock,
    ``,
    `Schema:`,
    `{`,
    `  "fields": {`,
    schemaKeys,
    `  },`,
    `  "tags": ["snake_case_topic", "tech::subtopic"]   // 1-4 tags; "::" for hierarchy`,
    `}`,
    ``,
    `Rules:`,
    `1. Output JSON only. Every key in "fields" MUST match the template field keys above exactly.`,
    `2. FRONT field(s) hold the question / cue. BACK field(s) hold the answer / explanation. EXTRA fields hold supporting context (examples, mnemonics, source) — fill them only if genuinely useful, otherwise return "".`,
    `3. The card must be FULLY self-contained. A learner who has not seen the source prompt must understand it.`,
    `4. For FRONT/BACK/html fields you may use safe inline HTML (<p>, <ul>, <li>, <strong>, <em>, <code>, <pre>, <br>). Do not include <script>, <style>, or external URLs.`,
    `5. For select fields, the value MUST be one of the listed options exactly. If unsure, return "".`,
    `6. Keep the FRONT concise (a single question or cloze prompt). Keep the BACK to ~1-3 sentences plus optional code/example.`,
    `7. Tags describe the SUBJECT (e.g. "javascript::async", "biology::cell"). Lowercase, snake_case, "::" for hierarchy.`,
  ].join('\n')
}

export async function generateAnkiNoteForTemplate(
  template:  AnkiTemplate,
  prompt:    string,
  maxTokens = 1500,
): Promise<AnkiNoteDraft | null> {
  const text = prompt.trim()
  if (!text) return null
  const reply = await LLM.chat([
    { role: 'system', content: buildSystemPrompt(template) },
    { role: 'user',   content: text },
  ], maxTokens)
  return normalize(parseLooseJson(reply), template)
}

function normalize(raw: unknown, template: AnkiTemplate): AnkiNoteDraft | null {
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as { fields?: unknown; tags?: unknown }
  const out: Record<string, string> = {}
  const incoming = (obj.fields && typeof obj.fields === 'object')
    ? obj.fields as Record<string, unknown>
    : {}
  // Only keep keys the template actually declares so unknown keys don't
  // leak into the sheet write.
  for (const f of template.fields) {
    const v = incoming[f.key]
    out[f.key] = typeof v === 'string' ? v : (v == null ? '' : String(v))
  }
  const tags = Array.isArray(obj.tags)
    ? obj.tags
        .filter((t): t is string => typeof t === 'string')
        .map(t => t.trim())
        .filter(Boolean)
    : []
  return { fields: out, tags }
}
