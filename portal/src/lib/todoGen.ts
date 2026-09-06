// Ask the LLM to produce a nested ToDo hierarchy from a free-form context
// (a goal, a project description, a brain-dump). The model returns strict
// JSON that mirrors the on-disk shape (title + description + children).
//
// The system prompt lives as an editable AI Skill (slug "todo_generate") so
// the user can tune it from Avatar → AI Skills without a code change. The
// default below seeds that row on first run.

import { LLM } from './llm'
import { ensureSkillBySlug, getSkillBySlug } from '../adapters/aiSkillsRepo'
import { parseLooseJson } from './looseJson'
import { deriveRootTitle } from './todoTitle'

export interface ToDoDraft {
  title:       string
  description: string
  children:    ToDoDraft[]
}

export const TODO_GENERATE_SLUG = 'todo_generate'

export const DEFAULT_TODO_GENERATE_PROMPT = [
  `You convert free-form context (a learning goal, a project description, a brain-dump) into a COMPREHENSIVE, NESTED, ACTIONABLE to-do tree the user can execute against without re-asking you anything.`,
  ``,
  `Output STRICT JSON ONLY — no prose, no markdown fences, no commentary. First character "{", last character "}".`,
  ``,
  `Schema:`,
  `{`,
  `  "root_title":       "SHORT label for the whole plan — 3 to 6 words, under 42 chars, names the goal like a folder name, not a sentence. e.g. 'GraphQL fundamentals', 'Rust for backend work'",`,
  `  "root_description": "1-2 sentences summarising the plan's intent / scope, for the user's future self",`,
  `  "todos": [`,
  `    {`,
  `      "title":       "short, imperative, ≤ 80 chars — what to DO",`,
  `      "description": "1-4 sentences: the WHY, acceptance criteria, key terminology, and (for technical topics) the specific tool / command / concept involved",`,
  `      "children":    [ /* same shape, recursive — empty array if none */ ]`,
  `    }`,
  `  ]`,
  `}`,
  ``,
  `Rules:`,
  `1. Output JSON only. No \`\`\` fences. First char "{", last char "}".`,
  `2. **Be broad.** Cover the topic comprehensively. For a learning / mastery goal, identify EVERY major sub-area a competent practitioner needs and emit a top-level todo for each. Don't be conservative — 8-15 top-level todos is reasonable for a meaty subject.`,
  `3. **Be deep.** Decompose each top-level item until every leaf is a single, concrete action (≤ 60 minutes of work). Allow up to 5 levels of nesting if needed. Do NOT stop at 2 levels — that is too shallow.`,
  `4. **ORDER BY DIFFICULTY — beginner first, expert last.** Sort both top-level todos AND children within each parent so the simplest / most foundational items come FIRST, then novice, then intermediate, and advanced / expert / "nice-to-have" items LAST. A reader should be able to start at the top and work down without hitting prerequisites they haven't met yet. This applies at every level of nesting.`,
  `5. **Be granular and actionable.** Leaves must be concrete and verb-led, e.g. "Run \`kubectl get pods -A\` and identify the system namespaces", NOT "Learn about pods". Bad: "Understand X". Good: "Read X docs section Y, then build Z".`,
  `6. **For technical topics**, weave in canonical jargon, command names, file names, and tool names directly in the titles (e.g. "Deployment", "ReplicaSet", "ConfigMap", "kubectl apply", "helm install", "Ingress controller"). Treat the description as a chance to mention adjacent concepts the user must know.`,
  `7. **Always include hands-on practice.** For each conceptual area, add at least one "Build / Run / Deploy / Break and fix" leaf so the user actually gets their hands on the tool, not just reads about it.`,
  `8. Title starts with an imperative verb (Read, Build, Deploy, Configure, Trace, Debug, Compare, Write, etc.). Description is meaningful and never a restatement of the title.`,
  `9. Be faithful to the user's stated level / time budget / context. Don't invent unrelated work, but DO fill in foundational gaps a person at the stated level would need.`,
  `10. If the context is too thin to break down, return {"todos": []}.`,
].join('\n')

// Read the user-editable instruction from the AI Skills tab, falling back to
// the default if the skill row hasn't been seeded yet. Both seed-on-first-run
// and a manual edit from the AI Skills page flow through this same path.
export async function getTodoGenerateInstruction(): Promise<string> {
  try {
    const skill = await getSkillBySlug(TODO_GENERATE_SLUG)
    if (skill && skill.instruction.trim()) return skill.instruction
  } catch { /* fall through to default */ }
  return DEFAULT_TODO_GENERATE_PROMPT
}

// Make sure the row exists (called by AI Skills view on mount so the user
// always sees the built-in instruction next to their custom ones).
export async function ensureTodoGenerateSkill() {
  return ensureSkillBySlug(TODO_GENERATE_SLUG, {
    name:        'ToDo Generator',
    description: 'System prompt used by Utils → ToDo → ✨ Generate. Edit here to change how AI breaks a goal into a hierarchy of actionable todos.',
    instruction: DEFAULT_TODO_GENERATE_PROMPT,
  })
}

export type GenerateReason = 'ok' | 'empty_context' | 'parse_failed' | 'no_todos_key' | 'empty_list'

export interface GenerateResult {
  drafts:          ToDoDraft[]
  rootTitle:       string         // LLM-supplied label for the whole plan
  rootDescription: string         // LLM-supplied summary
  raw:             string         // raw LLM response (or '' if we never called)
  reason:          GenerateReason
  prompt:          string         // system prompt that was used (for debugging)
}

export async function generateToDoHierarchy(
  context: string,
  maxTokens = 6000,
): Promise<GenerateResult> {
  const systemPrompt = await getTodoGenerateInstruction()
  const empty = (reason: GenerateReason, raw = ''): GenerateResult => ({
    drafts: [], rootTitle: '', rootDescription: '', raw, reason, prompt: systemPrompt,
  })
  if (!context.trim()) return empty('empty_context')
  const reply = await LLM.chat([
    { role: 'system', content: systemPrompt },
    { role: 'user',   content: context.trim() },
  ], maxTokens)
  const parsed = parse(reply)
  if (!parsed) {
    // eslint-disable-next-line no-console
    console.warn('[todoGen] parse failed. raw reply:', reply)
    return empty('parse_failed', reply)
  }
  if (!Array.isArray(parsed.todos)) {
    // eslint-disable-next-line no-console
    console.warn('[todoGen] no "todos" key in parsed object:', parsed)
    return empty('no_todos_key', reply)
  }
  const drafts = parsed.todos.map(normalize).filter((t): t is ToDoDraft => t != null)
  if (drafts.length === 0) {
    // eslint-disable-next-line no-console
    console.warn('[todoGen] empty todos array. raw reply:', reply)
    return empty('empty_list', reply)
  }
  const rootTitle       = typeof (parsed as any).root_title       === 'string' ? (parsed as any).root_title.trim()       : ''
  const rootDescription = typeof (parsed as any).root_description === 'string' ? (parsed as any).root_description.trim() : ''
  return {
    drafts,
    // The prompt asks for <= 60 chars but nothing made it so; a model that
    // ignores it produced the same run-on titles as the fallback did.
    rootTitle:       rootTitle ? deriveRootTitle(rootTitle) : deriveRootTitle(context),
    rootDescription: rootDescription || `Generated from: ${context.trim().slice(0, 200)}`,
    raw:    reply,
    reason: 'ok',
    prompt: systemPrompt,
  }
}


function normalize(t: any): ToDoDraft | null {
  if (!t || typeof t !== 'object') return null
  const title = typeof t.title === 'string' ? t.title.trim() : ''
  if (!title) return null
  const description = typeof t.description === 'string' ? t.description.trim() : ''
  const children = Array.isArray(t.children)
    ? t.children.map(normalize).filter((c: any): c is ToDoDraft => c != null)
    : []
  return { title, description, children }
}

function parse(s: string): { todos?: any[] } | null {
  const out = parseLooseJson(s)
  return (out && typeof out === 'object') ? out as { todos?: any[] } : null
}
