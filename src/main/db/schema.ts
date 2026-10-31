// Database migrations. Each entry runs once, in order, and bumps meta.schema_version.
// Never edit a migration that has shipped. Add a new one instead.
// An entry is either SQL or a function that gets the open database, for changes that need code.

import { createHash } from 'node:crypto'
import type { Database } from 'sql.js'

export type Migration = string | ((db: Database) => void)

export const MIGRATIONS: Migration[] = [
  /* 1: initial schema */ `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Settings are stored as one JSON document per top-level key (routing, budget, ...).
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE providers (
    id          TEXT PRIMARY KEY,
    kind        TEXT NOT NULL,
    label       TEXT NOT NULL,
    base_url    TEXT,
    api_key_enc TEXT,            -- base64 of bytes encrypted with Electron safeStorage
    created_at  TEXT NOT NULL
  );

  -- Single row. version goes up whenever the profile changes in a way that affects fit scores.
  CREATE TABLE profile (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    data       TEXT NOT NULL,
    version    INTEGER NOT NULL,
    hash       TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE documents (
    id         TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,     -- resume | cover_letter_sample | writing_sample | portfolio | other
    name       TEXT NOT NULL,
    file_path  TEXT,              -- copy kept inside the app data folder
    mime       TEXT,
    url        TEXT,
    text       TEXT NOT NULL DEFAULT '',
    is_primary INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE answer_bank (
    id            TEXT PRIMARY KEY,
    question      TEXT NOT NULL,
    question_norm TEXT NOT NULL,
    answer        TEXT NOT NULL,
    kind          TEXT NOT NULL,  -- fact | template
    times_used    INTEGER NOT NULL DEFAULT 0,
    updated_at    TEXT NOT NULL
  );
  CREATE INDEX idx_answer_bank_norm ON answer_bank(question_norm);

  CREATE TABLE companies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    name_norm   TEXT NOT NULL,
    ats         TEXT NOT NULL DEFAULT 'unknown',
    ats_token   TEXT,
    careers_url TEXT,
    watch       INTEGER NOT NULL DEFAULT 0,
    blocked     INTEGER NOT NULL DEFAULT 0,
    notes       TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL
  );
  CREATE UNIQUE INDEX idx_companies_ats ON companies(ats, ats_token) WHERE ats_token IS NOT NULL;
  CREATE INDEX idx_companies_name ON companies(name_norm);

  CREATE TABLE searches (
    id          TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    label       TEXT NOT NULL,
    params      TEXT NOT NULL,    -- JSON object
    enabled     INTEGER NOT NULL DEFAULT 1,
    last_run_at TEXT
  );

  CREATE TABLE jobs (
    id                     TEXT PRIMARY KEY,
    source                 TEXT NOT NULL,
    external_id            TEXT NOT NULL,
    canonical_key          TEXT NOT NULL UNIQUE,  -- source + company + external id
    content_hash           TEXT NOT NULL,         -- company + title + description fingerprint
    dup_of                 TEXT,
    company                TEXT NOT NULL,
    company_norm           TEXT NOT NULL,
    company_id             TEXT,
    title                  TEXT NOT NULL,
    location               TEXT,
    remote                 TEXT NOT NULL DEFAULT 'unknown',
    salary_min             INTEGER,
    salary_max             INTEGER,
    salary_currency        TEXT,
    employment_type        TEXT,
    url                    TEXT NOT NULL,
    apply_url              TEXT,
    ats                    TEXT NOT NULL DEFAULT 'unknown',
    ats_token              TEXT,
    description            TEXT NOT NULL,
    posted_at              TEXT,
    discovered_at          TEXT NOT NULL,
    closed_at              TEXT,
    stage                  TEXT NOT NULL,
    filter_reason          TEXT,
    prescore               REAL,
    fit_score              INTEGER,
    fit_bucket             TEXT,
    fit_summary            TEXT,
    fit_json               TEXT,
    scored_profile_version INTEGER,
    dismiss_reason         TEXT,
    dismiss_tags           TEXT NOT NULL DEFAULT '[]',
    starred                INTEGER NOT NULL DEFAULT 0,
    updated_at             TEXT NOT NULL
  );
  CREATE INDEX idx_jobs_stage ON jobs(stage);
  CREATE INDEX idx_jobs_content_hash ON jobs(content_hash);
  CREATE INDEX idx_jobs_company_norm ON jobs(company_norm);
  CREATE INDEX idx_jobs_discovered ON jobs(discovered_at);
  CREATE INDEX idx_jobs_fit ON jobs(fit_score);

  CREATE TABLE applications (
    id                TEXT PRIMARY KEY,
    job_id            TEXT NOT NULL UNIQUE REFERENCES jobs(id),
    status            TEXT NOT NULL,
    outcome           TEXT NOT NULL DEFAULT 'none',
    outcome_at        TEXT,
    cover_letter      TEXT,
    cover_letter_lint TEXT,          -- JSON LintReport
    answers           TEXT NOT NULL DEFAULT '[]',  -- JSON PreparedAnswer[]
    form_fields       TEXT NOT NULL DEFAULT '[]',  -- JSON FormField[]
    resume_doc_id     TEXT,
    submit_mode       TEXT,
    submitted_at      TEXT,
    confirmation      TEXT,
    screenshot_path   TEXT,
    error             TEXT,
    notes             TEXT NOT NULL DEFAULT '',
    created_at        TEXT NOT NULL,
    updated_at        TEXT NOT NULL
  );
  CREATE INDEX idx_applications_status ON applications(status);
  CREATE INDEX idx_applications_submitted ON applications(submitted_at);

  -- One row per model call, including calls answered from the local cache (cache_hit = 1, cost 0).
  CREATE TABLE llm_calls (
    id                  TEXT PRIMARY KEY,
    at                  TEXT NOT NULL,
    task                TEXT NOT NULL,
    stage               TEXT NOT NULL,
    provider_kind       TEXT NOT NULL,
    model               TEXT NOT NULL,
    job_id              TEXT,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd            REAL NOT NULL DEFAULT 0,
    cache_hit           INTEGER NOT NULL DEFAULT 0,
    duration_ms         INTEGER NOT NULL DEFAULT 0,
    ok                  INTEGER NOT NULL DEFAULT 1,
    error               TEXT
  );
  CREATE INDEX idx_llm_calls_at ON llm_calls(at);
  CREATE INDEX idx_llm_calls_job ON llm_calls(job_id);

  -- Responses keyed by a hash of model + prompt version + inputs. Same inputs never pay twice.
  CREATE TABLE llm_cache (
    key        TEXT PRIMARY KEY,
    task       TEXT NOT NULL,
    value      TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE events (
    id      TEXT PRIMARY KEY,
    at      TEXT NOT NULL,
    type    TEXT NOT NULL,
    job_id  TEXT,
    message TEXT NOT NULL,
    data    TEXT
  );
  CREATE INDEX idx_events_at ON events(at);
  CREATE INDEX idx_events_job ON events(job_id);
  CREATE INDEX idx_events_type ON events(type);

  CREATE TABLE runs (
    id          TEXT PRIMARY KEY,
    trigger     TEXT NOT NULL,
    started_at  TEXT NOT NULL,
    finished_at TEXT,
    stats       TEXT NOT NULL,
    error       TEXT
  );
  `,

  /* 2: when the app itself clicked Submit, so a click with no confirmation is never repeated */ `
  ALTER TABLE applications ADD COLUMN submit_clicked_at TEXT;
  `,

  /* 3: last_seen_at and dismissed_at, board-based job keys, full-description content hashes */ migrateJobKeysAndHashes
]

interface KeyRow {
  id: string
  source: string
  external_id: string
  canonical_key: string
  content_hash: string
  dup_of: string | null
  company: string
  title: string
  description: string
  ats: string
  ats_token: string | null
  stage: string
  discovered_at: string
  starred: number
  has_application: number
}

/**
 * Adds last_seen_at and dismissed_at, then re-keys and re-hashes every job.
 *
 * Postings on an ATS board get the key source:token:externalId, so a company rename no longer
 * stores the board again. Two rows can already share the new key when an earlier rename stored a
 * board twice. canonical_key is UNIQUE, so for each such group one row keeps the key: the one with
 * an application, else the one that is not already a duplicate, else the oldest. The others get a
 * key ending in ~their id. Those without an application and not dismissed or applied become
 * duplicates of the kept row. No row is deleted.
 *
 * The content hash now covers the whole description. A duplicate of a job from the same source
 * whose new hash differs was merged only because its first 600 characters matched. It goes back to
 * 'new' so the next run looks at it.
 */
function migrateJobKeysAndHashes(db: Database): void {
  db.exec(`
    ALTER TABLE jobs ADD COLUMN last_seen_at TEXT;
    ALTER TABLE jobs ADD COLUMN dismissed_at TEXT;
    UPDATE jobs SET last_seen_at = updated_at;
    UPDATE jobs SET dismissed_at = COALESCE((SELECT MAX(e.at) FROM events e WHERE e.type = 'dismissed' AND e.job_id = jobs.id), updated_at)
      WHERE stage = 'dismissed';
    CREATE INDEX idx_jobs_last_seen ON jobs(last_seen_at);
  `)

  const rows: KeyRow[] = []
  const select = db.prepare(
    `SELECT j.id, j.source, j.external_id, j.canonical_key, j.content_hash, j.dup_of, j.company, j.title, j.description,
       j.ats, j.ats_token, j.stage, j.discovered_at, j.starred,
       EXISTS (SELECT 1 FROM applications a WHERE a.job_id = j.id) AS has_application
     FROM jobs j`
  )
  while (select.step()) rows.push(select.getAsObject() as unknown as KeyRow)
  select.free()
  if (rows.length === 0) return

  const finalKey = new Map<string, string>()
  const newHash = new Map<string, string>()
  const groups = new Map<string, KeyRow[]>()
  for (const row of rows) {
    const key = m3Key(row)
    finalKey.set(row.id, key)
    newHash.set(row.id, m3Hash(row))
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }

  // Decide who keeps each key.
  const keeperOf = new Map<string, string>() // loser id -> keeper id
  const rank = (r: KeyRow) => [r.has_application ? 0 : 1, r.stage === 'duplicate' ? 1 : 0, r.discovered_at, r.id] as const
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => {
      const x = rank(a)
      const y = rank(b)
      return x[0] - y[0] || x[1] - y[1] || (x[2] < y[2] ? -1 : x[2] > y[2] ? 1 : 0) || (x[3] < y[3] ? -1 : 1)
    })
    for (const loser of sorted.slice(1)) keeperOf.set(loser.id, sorted[0].id)
    if (sorted.slice(1).some((r) => r.starred === 1)) db.run('UPDATE jobs SET starred = 1 WHERE id = ?', [sorted[0].id])
  }

  // Free every key first, so no update can collide with a key another row is about to leave.
  db.run("UPDATE jobs SET canonical_key = 'migrating:' || id")
  const byId = new Map(rows.map((r) => [r.id, r]))
  for (const row of rows) {
    const keeper = keeperOf.get(row.id)
    const key = keeper ? `${finalKey.get(row.id)}~${row.id}` : finalKey.get(row.id)!
    db.run('UPDATE jobs SET canonical_key = ?, content_hash = ? WHERE id = ?', [key, newHash.get(row.id)!, row.id])
    if (!keeper) continue
    db.run('UPDATE jobs SET dup_of = ? WHERE dup_of = ? AND id != ?', [keeper, row.id, keeper])
    // The kept row may have pointed at the row it replaces. A job can't be a duplicate of itself.
    if (byId.get(keeper)?.dup_of === row.id) {
      db.run("UPDATE jobs SET dup_of = NULL, stage = CASE WHEN stage = 'duplicate' THEN 'new' ELSE stage END WHERE id = ?", [keeper])
    }
    if (!row.has_application && !['dismissed', 'applied', 'duplicate'].includes(row.stage)) {
      db.run("UPDATE jobs SET stage = 'duplicate', dup_of = ?, filter_reason = NULL WHERE id = ?", [keeper, row.id])
    }
  }

  // Duplicates that only matched on the first 600 characters of the description.
  for (const row of rows) {
    if (keeperOf.has(row.id) || row.stage !== 'duplicate' || !row.dup_of || row.has_application) continue
    const original = byId.get(row.dup_of)
    if (!original || original.source !== row.source) continue
    if (newHash.get(original.id) === newHash.get(row.id)) continue
    db.run("UPDATE jobs SET stage = 'new', dup_of = NULL, filter_reason = NULL, prescore = NULL WHERE id = ?", [row.id])
  }
}

// Migration 3 keeps its own copy of the job key and fingerprint as they were when it was written.
// pipeline/dedupe.ts can change later without changing what this migration does for someone who
// upgrades from an old version.
const M3_COMPANY_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'gmbh', 'corp', 'corporation', 'co', 'company',
  'plc', 'ag', 'sa', 'bv', 'oy', 'ab', 'pty', 'lp', 'llp'
])

function m3Company(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  while (words.length > 1 && M3_COMPANY_SUFFIXES.has(words[words.length - 1])) words.pop()
  return words.join(' ')
}

function m3Text(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}+#]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function m3Key(row: Pick<KeyRow, 'source' | 'company' | 'external_id' | 'ats' | 'ats_token'>): string {
  const token = row.ats_token?.trim()
  if (row.ats && row.ats !== 'unknown' && token) return `${row.source}:${token.toLowerCase()}:${row.external_id}`
  return `${row.source}:${m3Company(row.company)}:${row.external_id}`
}

function m3Hash(row: Pick<KeyRow, 'company' | 'title' | 'description'>): string {
  return createHash('sha1').update(`${m3Company(row.company)}\n${m3Text(row.title)}\n${m3Text(row.description)}`).digest('hex')
}
