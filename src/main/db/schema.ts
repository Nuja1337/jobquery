// Database migrations. Each entry runs once, in order, and bumps meta.schema_version.
// Never edit a migration that has shipped. Add a new one instead.

export const MIGRATIONS: string[] = [
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
  `
]
