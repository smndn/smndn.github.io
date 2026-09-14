/** SQLite schema v1 for the singleton ParliamentaryDisclosures Durable Object. */

export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
  id INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS politicians (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  chamber TEXT NOT NULL,
  electorate TEXT,
  state TEXT,
  party TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  politician_id INTEGER,
  parliament INTEGER,
  chamber TEXT NOT NULL,
  source_url TEXT NOT NULL,
  source_title TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  UNIQUE(source_url, parliament, chamber)
);

CREATE TABLE IF NOT EXISTS source_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  fetched_at TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  content_length INTEGER,
  http_etag TEXT,
  http_last_modified TEXT,
  extraction_method TEXT,
  model TEXT,
  model_version TEXT,
  parser_version TEXT,
  schema_version TEXT,
  parse_status TEXT NOT NULL DEFAULT 'pending',
  parse_confidence REAL,
  disclosure_count INTEGER DEFAULT 0,
  error_summary TEXT,
  UNIQUE(source_id, sha256)
);

CREATE TABLE IF NOT EXISTS disclosures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_version_id INTEGER NOT NULL,
  politician_id INTEGER,
  parliament INTEGER,
  chamber TEXT,
  category TEXT,
  event_type TEXT,
  subject TEXT,
  disclosure_date TEXT,
  lodged_date TEXT,
  raw_text TEXT NOT NULL,
  raw_text_hash TEXT NOT NULL,
  source_page INTEGER,
  parser_confidence REAL,
  manually_verified INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(source_version_id, category, event_type, raw_text_hash, politician_id)
);

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  canonical_name TEXT NOT NULL,
  entity_type TEXT,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS disclosure_entities (
  disclosure_id INTEGER NOT NULL,
  entity_id INTEGER NOT NULL,
  role TEXT,
  confidence REAL,
  PRIMARY KEY (disclosure_id, entity_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  slug TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS disclosure_tags (
  disclosure_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  confidence REAL,
  source TEXT,
  manual_override INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (disclosure_id, tag_id)
);

CREATE TABLE IF NOT EXISTS aviation_details (
  disclosure_id INTEGER PRIMARY KEY,
  aviation_type TEXT,
  airline_entity_id INTEGER,
  airport_entity_id INTEGER,
  status_name TEXT,
  lounge_name TEXT,
  cabin_from TEXT,
  cabin_to TEXT,
  requested INTEGER,
  complimentary INTEGER,
  sponsored INTEGER,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS editorial (
  disclosure_id INTEGER PRIMARY KEY,
  featured INTEGER NOT NULL DEFAULT 0,
  interesting INTEGER NOT NULL DEFAULT 0,
  aviation_featured INTEGER NOT NULL DEFAULT 0,
  needs_review INTEGER NOT NULL DEFAULT 0,
  investigated INTEGER NOT NULL DEFAULT 0,
  interest_score INTEGER,
  editorial_note TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS ingestion_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_type TEXT NOT NULL,
  source_id INTEGER,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT,
  next_retry_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS parser_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_version_id INTEGER,
  model TEXT,
  model_version TEXT,
  parser_version TEXT,
  schema_version TEXT,
  started_at TEXT,
  completed_at TEXT,
  status TEXT,
  input_kind TEXT,
  error_summary TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS disclosures_fts USING fts5(
  raw_text,
  politician_name,
  entity_names,
  tags,
  content=''
);
`;
