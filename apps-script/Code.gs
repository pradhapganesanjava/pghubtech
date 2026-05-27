/**
 * pghubtech — "File a card from text" Web App
 * ─────────────────────────────────────────────────────────────────────────────
 * A Google Apps Script web app, bound by Sheet ID to the same spreadsheet the
 * portal SPA uses. It accepts a free-text payload over HTTP (curl), asks Azure
 * OpenAI to pick the best EXISTING deck + template, generate the card fields,
 * and suggest tags, then appends the new note row in the SAME format the portal
 * uses (Browse/Add → appendAnkiNote):
 *
 *     [ anki_note_id, deck, anki_mod, ...fieldValues(by order), tags.join(', ') ]
 *
 * Because the web app is deployed "Execute as me / Access: only myself", it runs
 * as the sheet owner and has native SpreadsheetApp access — no OAuth token from
 * the SPA, no service account. Callers authenticate with an OAuth bearer token
 * for the owner account (see apps-script/README.md).
 *
 * ── Required Script Properties (Project Settings → Script Properties) ──────────
 *   SHEET_ID            the spreadsheet id (same as the portal's VITE_SHEET_ID)
 *   AZURE_ENDPOINT      e.g. https://my-resource.openai.azure.com
 *   AZURE_API_KEY       Azure OpenAI key
 *   AZURE_DEPLOYMENT    (optional) deployment/model name   — default "gpt-4o"
 *   AZURE_API_VERSION   (optional) api version             — default "2024-12-01-preview"
 *
 * Mirrors: portal/src/adapters/ankiRepo.ts (schema + row format) and
 *          portal/src/lib/{llm.ts,ankiNoteGen.ts,looseJson.ts} (AI call + parse).
 */

var TEMPLATES_TAB    = 'Templates';
var MAX_TOKENS       = 1500;
var SAMPLE_TAGS_MAX  = 8;    // sample tags shown per deck in the prompt
var DECKS_MAX        = 80;   // cap decks listed in the prompt

// ── HTTP entry points ─────────────────────────────────────────────────────────

function doPost(e) {
  try {
    var body = {};
    if (e && e.postData && e.postData.contents) {
      body = JSON.parse(e.postData.contents);
    }
    var text = String((body && body.text) || '').trim();
    if (!text) return json_({ ok: false, error: 'Missing "text" in request body.' });

    var result = fileCardFromText_(text, body);
    return json_(result);
  } catch (err) {
    return json_({ ok: false, error: errMsg_(err) });
  }
}

// GET is handy for a quick auth/health check from the browser or curl.
function doGet() {
  return json_({
    ok: true,
    service: 'pghubtech file-a-card',
    usage: 'POST JSON { "text": "<what to study>", "deck"?: "<override>", "templateId"?: "<override>" }',
  });
}

// ── Core flow ───────────────────────────────────────────────────────────────

function fileCardFromText_(text, body) {
  var ss        = SpreadsheetApp.openById(sheetId_());
  var templates = loadTemplates_(ss);
  if (!templates.length) {
    return { ok: false, error: 'No templates found in the "' + TEMPLATES_TAB + '" tab.' };
  }
  var deckInfo = loadDeckInfo_(ss, templates); // { decks:[{deck,count,sampleTags}], byTemplate:{} }

  // Ask the model to choose template + deck and produce fields + tags.
  var ai = askAi_(text, templates, deckInfo, body);

  // ── Resolve template (AI choice → body override → first) ────────────────────
  var template =
    findTemplateById_(templates, body && body.templateId) ||
    findTemplateById_(templates, ai && ai.templateId) ||
    templates[0];

  // ── Resolve deck. Prefer an existing deck (intent: reuse existing decks).
  // A deck explicitly supplied in the body may be new; an AI-picked deck is
  // canonicalised to an existing one, falling back to the most common deck. ──
  var existingDecks = deckInfo.decks.map(function (d) { return d.deck; });
  var deck = resolveDeck_(
    (body && body.deck) ? String(body.deck).trim() : '',
    ai && ai.deck ? String(ai.deck).trim() : '',
    existingDecks,
    mostCommonDeckForTemplate_(deckInfo, template.id)
  );
  if (!deck) {
    return { ok: false, error: 'Could not determine a deck (no existing decks and none supplied).' };
  }

  // ── Keep only the chosen template's field keys; coerce to strings ───────────
  var fields = {};
  template.fields.forEach(function (f) {
    var v = ai && ai.fields ? ai.fields[f.key] : '';
    fields[f.key] = (v == null) ? '' : String(v);
  });

  var tags = normalizeTags_(ai && ai.tags);

  // ── Append the row, exactly like ankiRepo.appendAnkiNote ────────────────────
  var noteId  = newNoteId_();
  var ankiMod = String(Date.now());
  var row     = buildRow_(template, noteId, deck, ankiMod, fields, tags);

  var sheet = ss.getSheetByName(template.id);
  if (!sheet) return { ok: false, error: 'Template tab "' + template.id + '" not found in the sheet.' };
  sheet.appendRow(row);

  return {
    ok: true,
    message: 'Card added.',
    noteId: noteId,
    templateId: template.id,
    templateName: template.displayName,
    deck: deck,
    tags: tags,
    fields: fields,
  };
}

// ── Templates: parse the "Templates" tab (parity with fetchTemplates) ─────────

function loadTemplates_(ss) {
  var sheet = ss.getSheetByName(TEMPLATES_TAB);
  if (!sheet) return [];
  var rows = sheet.getDataRange().getValues();
  if (!rows.length) return [];

  var header = rows[0].map(function (c) { return String(c); });
  var col = function (k) { return header.indexOf(k); };

  var order = [];                 // preserve first-seen template order
  var byId  = {};
  for (var i = 1; i < rows.length; i++) {
    var r  = rows[i];
    var id = String(r[col('template_id')] || '');
    if (!id) continue;
    if (!byId[id]) {
      byId[id] = { id: id, displayName: String(r[col('template_name')] || id), fields: [] };
      order.push(id);
    }
    var key = String(r[col('field_key')] || '');
    if (!key || key === 'tags') continue; // tags is a trailing column, not a field
    byId[id].fields.push({
      key:     key,
      label:   String(r[col('field_label')] || key),
      type:    String(r[col('field_type')] || 'text'),
      isFront: String(r[col('is_front')]) === 'TRUE',
      isBack:  String(r[col('is_back')])  === 'TRUE',
      order:   parseInt(r[col('field_order')] || '0', 10) || 0,
      options: String(r[col('options')] || ''),
    });
  }

  return order.map(function (id) {
    var t = byId[id];
    t.fields.sort(function (a, b) { return a.order - b.order; });
    return t;
  });
}

// ── Decks + sample tags: scan each template tab once ──────────────────────────

function loadDeckInfo_(ss, templates) {
  var deckMap = {};            // deck -> { count, tagFreq:{tag:count} }
  var byTemplate = {};         // templateId -> { deck -> count }

  templates.forEach(function (t) {
    var sheet = ss.getSheetByName(t.id);
    if (!sheet) return;
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return;

    var deckCol = 1;                  // col B
    var tagsCol = 3 + t.fields.length; // trailing tags column (0-based)
    byTemplate[t.id] = byTemplate[t.id] || {};

    for (var i = 1; i < values.length; i++) {
      var r = values[i];
      if (!r[0]) continue;            // no note id → skip
      var deck = String(r[deckCol] || '').trim();
      if (!deck) continue;

      var dm = deckMap[deck] || (deckMap[deck] = { count: 0, tagFreq: {} });
      dm.count++;
      byTemplate[t.id][deck] = (byTemplate[t.id][deck] || 0) + 1;

      var tagsRaw = String(r[tagsCol] || '');
      tagsRaw.split(',').forEach(function (tag) {
        var tg = tag.trim();
        if (tg) dm.tagFreq[tg] = (dm.tagFreq[tg] || 0) + 1;
      });
    }
  });

  var decks = Object.keys(deckMap).map(function (deck) {
    var freq = deckMap[deck].tagFreq;
    var sampleTags = Object.keys(freq)
      .sort(function (a, b) { return freq[b] - freq[a]; })
      .slice(0, SAMPLE_TAGS_MAX);
    return { deck: deck, count: deckMap[deck].count, sampleTags: sampleTags };
  }).sort(function (a, b) { return b.count - a.count; });

  return { decks: decks, byTemplate: byTemplate };
}

function mostCommonDeckForTemplate_(deckInfo, templateId) {
  var m = deckInfo.byTemplate[templateId];
  if (!m) return '';
  var best = '', bestN = -1;
  Object.keys(m).forEach(function (d) { if (m[d] > bestN) { bestN = m[d]; best = d; } });
  return best;
}

// ── AI call (parity with llm.ts + ankiNoteGen.ts) ─────────────────────────────

function askAi_(text, templates, deckInfo, body) {
  var system = buildSystemPrompt_(templates, deckInfo, body);
  var reply  = azureChat_([
    { role: 'system', content: system },
    { role: 'user',   content: text },
  ], MAX_TOKENS);
  return parseLooseJson_(reply) || {};
}

function buildSystemPrompt_(templates, deckInfo, body) {
  var pinnedTpl  = body && body.templateId ? String(body.templateId) : '';
  var pinnedDeck = body && body.deck ? String(body.deck) : '';

  var tplBlock = templates.map(function (t) {
    var lines = t.fields.map(function (f) {
      var role = f.isFront ? 'FRONT' : f.isBack ? 'BACK' : 'EXTRA';
      var hint =
        (f.type === 'select' && f.options) ? ('enum (one of: ' + f.options + ')')
        : (f.type === 'html' || f.isFront || f.isBack) ? 'HTML allowed (<code>,<ul>,<strong>,<br>, …)'
        : 'plain text';
      return '      - "' + f.key + '" (' + f.label + ') — role=' + role + ', ' + hint;
    }).join('\n');
    return '  - templateId "' + t.id + '" — "' + t.displayName + '":\n' + lines;
  }).join('\n');

  var deckBlock = deckInfo.decks.slice(0, DECKS_MAX).map(function (d) {
    var st = d.sampleTags.length ? ('  (sample tags: ' + d.sampleTags.join(', ') + ')') : '';
    return '  - "' + d.deck + '"' + st;
  }).join('\n') || '  (no existing decks yet)';

  var out = [
    'You file ONE spaced-repetition flashcard into an existing Anki-style collection.',
    'From the lists below, choose the SINGLE best-fitting template and the SINGLE best-fitting EXISTING deck, then write the card.',
    'Output STRICT JSON ONLY — no prose, no markdown fences. First character "{", last character "}".',
    '',
    'Available templates (pick one "templateId"):',
    tplBlock,
    '',
    'Existing decks (pick one "deck", copied EXACTLY as written; reuse the sample tags where apt):',
    deckBlock,
    '',
    'Schema:',
    '{',
    '  "templateId": "<one of the templateIds above>",',
    '  "deck": "<one of the decks above, copied exactly>",',
    '  "tags": ["snake_case_topic", "tech::subtopic"],',
    '  "fields": { "<fieldKey>": "<value>", … }',
    '}',
    '',
    'Rules:',
    '1. Output JSON only. "templateId" MUST be exactly one of the listed ids.',
    '2. "deck" MUST be exactly one of the listed decks (copy the string verbatim, including "::").',
    '3. Every key in "fields" MUST be a field key of the chosen template. Omit/blank ("") fields that do not apply.',
    '4. FRONT field(s) = question/cue; BACK field(s) = answer/explanation; EXTRA = supporting context (fill only if useful).',
    '5. The card must be FULLY self-contained — understandable without the source text.',
    '6. For FRONT/BACK/html fields you may use safe inline HTML (<p>,<ul>,<li>,<strong>,<em>,<code>,<pre>,<br>). No <script>, <style>, or external URLs.',
    '7. For select fields the value MUST be one of its listed options exactly, else "".',
    '8. Tags: lowercase, snake_case, "::" for hierarchy, 1-4 tags; prefer reusing the deck\'s sample tags.',
  ];
  if (pinnedTpl)  out.push('9. The caller REQUIRES templateId = "' + pinnedTpl + '". Use it.');
  if (pinnedDeck) out.push('10. The caller REQUIRES deck = "' + pinnedDeck + '". Use it.');
  return out.join('\n');
}

// Azure OpenAI chat completion — mirrors portal/src/lib/llm.ts
function azureChat_(messages, maxTokens) {
  var endpoint = cfg_('AZURE_ENDPOINT', '').replace(/\/$/, '');
  var apiKey   = cfg_('AZURE_API_KEY', '');
  var dep      = cfg_('AZURE_DEPLOYMENT', 'gpt-4o');
  var ver      = cfg_('AZURE_API_VERSION', '2024-12-01-preview');
  if (!endpoint || !apiKey) {
    throw new Error('Azure OpenAI not configured — set AZURE_ENDPOINT and AZURE_API_KEY in Script Properties.');
  }
  var url = endpoint + '/openai/deployments/' + dep + '/chat/completions?api-version=' + ver;
  var res = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'api-key': apiKey },
    payload: JSON.stringify({ messages: messages, max_completion_tokens: maxTokens }),
    muteHttpExceptions: true,
  });
  var code = res.getResponseCode();
  var txt  = res.getContentText();
  if (code < 200 || code >= 300) {
    var msg = txt;
    try { msg = JSON.parse(txt).error.message; } catch (e) {}
    throw new Error('Azure OpenAI HTTP ' + code + ': ' + msg);
  }
  var data = JSON.parse(txt);
  return (data.choices && data.choices[0] && data.choices[0].message &&
          data.choices[0].message.content || '').trim();
}

// Lenient JSON extraction — parity with portal/src/lib/looseJson.ts.
// Tolerates: (1) ```json fences, (2) stray prose around the object,
// (3) truncated responses (LLM hit max_tokens mid-value) by walking the
// bracket stack and closing still-open structures in the correct order.
function parseLooseJson_(input) {
  var t = String(input == null ? '' : input).trim();
  if (!t) return null;
  // 1. Direct
  try { return JSON.parse(t); } catch (e) {}
  // 2. ```json fence
  var fence = t.match(/^```(?:json)?\s*([\s\S]*?)\s*```\s*$/i);
  if (fence) { try { return JSON.parse(fence[1]); } catch (e1) {} }
  // 3. Object slice "{ … }"
  var start = t.indexOf('{');
  var end   = t.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(t.slice(start, end + 1)); } catch (e2) {}
  }
  // 4. Repair: try every "safe" boundary, latest → earliest.
  if (start >= 0) {
    var candidates = repairedCandidates_(t.slice(start));
    for (var i = 0; i < candidates.length; i++) {
      try { return JSON.parse(candidates[i]); } catch (e3) {}
    }
  }
  return null;
}

function repairedCandidates_(input) {
  var stack = [], inStr = false, esc = false, snapshots = [];
  for (var i = 0; i < input.length; i++) {
    var c = input[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') { esc = true; continue; }
      if (c === '"')  { inStr = false; continue; }
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { stack.push('}'); continue; }
    if (c === '[') { stack.push(']'); continue; }
    if (c === '}' || c === ']') {
      if (stack.pop() !== c) break; // structural mismatch — stop
      snapshots.push({ end: i + 1, stack: stack.slice() });
      continue;
    }
    if (c === ',') { snapshots.push({ end: i, stack: stack.slice() }); }
  }
  var out = [];
  if (stack.length === 0 && !inStr) out.push(input);
  var MAX_ATTEMPTS = 300, attempts = 0;
  for (var j = snapshots.length - 1; j >= 0 && attempts < MAX_ATTEMPTS; j--, attempts++) {
    var snap = snapshots[j];
    var trimmed = input.slice(0, snap.end).replace(/[\s,]+$/, '');
    for (var k = snap.stack.length - 1; k >= 0; k--) trimmed += snap.stack[k];
    out.push(trimmed);
  }
  return out;
}

// ── Resolution / validation helpers ───────────────────────────────────────────

function findTemplateById_(templates, id) {
  if (!id) return null;
  for (var i = 0; i < templates.length; i++) {
    if (templates[i].id === id) return templates[i];
  }
  return null;
}

function resolveDeck_(bodyDeck, aiDeck, existingDecks, fallbackDeck) {
  var canon = function (name) {
    if (!name) return '';
    for (var i = 0; i < existingDecks.length; i++) {
      if (existingDecks[i].toLowerCase() === name.toLowerCase()) return existingDecks[i];
    }
    return '';
  };
  // Explicit body deck wins; allowed to be a brand-new deck.
  if (bodyDeck) return canon(bodyDeck) || bodyDeck;
  // AI deck must be an existing deck; otherwise fall back so we never invent.
  var c = canon(aiDeck);
  if (c) return c;
  if (fallbackDeck) return fallbackDeck;
  return existingDecks.length ? existingDecks[0] : '';
}

function normalizeTags_(raw) {
  if (!Array.isArray(raw)) return [];
  var seen = {}, out = [];
  raw.forEach(function (t) {
    if (typeof t !== 'string') return;
    var tg = t.trim();
    if (tg && !seen[tg]) { seen[tg] = 1; out.push(tg); }
  });
  return out;
}

// Row format identical to ankiRepo.appendAnkiNote:
//   [noteId, deck, ankiMod, ...fieldValues(sorted by order), tags.join(', ')]
function buildRow_(template, noteId, deck, ankiMod, fields, tags) {
  var sorted = template.fields.slice().sort(function (a, b) { return a.order - b.order; });
  var fieldValues = sorted.map(function (f) { return fields[f.key] != null ? fields[f.key] : ''; });
  return [noteId, deck, ankiMod].concat(fieldValues).concat([tags.join(', ')]);
}

// noteId format identical to AddNoteModal: c-<base36 time>-<rand5>
function newNoteId_() {
  return 'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

// ── Config / utils ─────────────────────────────────────────────────────────────

function cfg_(key, def) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v != null && v !== '') ? v : def;
}

function sheetId_() {
  var id = cfg_('SHEET_ID', '');
  if (!id) throw new Error('SHEET_ID not set in Script Properties.');
  return id;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function errMsg_(err) {
  return (err && err.message) ? err.message : String(err);
}

// ── Run-from-editor smoke test (authorizes scopes; check the execution log) ───
function test_() {
  var out = fileCardFromText_(
    'Explain the difference between TCP and UDP for a backend interview.',
    {}
  );
  Logger.log(JSON.stringify(out, null, 2));
}
