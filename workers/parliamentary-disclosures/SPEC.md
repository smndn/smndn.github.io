BUILD SPEC: SIMONDEAN.XYZ PARLIAMENTARY DISCLOSURES

Project goal
============

Build a new subsection of simondean.xyz at:

    /parliamentary-disclosures

The feature should ingest Australian federal parliamentary disclosure records, parse them into structured data using Muse Spark 1.3 Contributor or an equivalent low-cost model, store the structured records in a single SQLite-backed Cloudflare Durable Object, and expose a searchable public interface with a strong editorial focus on aviation-related disclosures.

The site is not intended to be an archival mirror of Parliament.

Parliament of Australia remains the authoritative source.

Our job is to:

1. discover official disclosure documents,
2. fetch them temporarily,
3. record exactly where and when they were accessed,
4. fingerprint each fetched document,
5. parse every disclosure into structured records,
6. keep the exact source wording for every extracted item,
7. classify and tag those items,
8. provide search, browsing, analytics and editorial surfaces,
9. link users back to the original official Parliamentary source.

Do not store copies of the source PDFs after parsing.
Do not use R2.
Do not use D1.
Do not integrate Archive.org.
Do not attempt to become an archival service.

The architecture should be deliberately small and self-contained.


CORE ARCHITECTURE
=================

Use a single Cloudflare Worker deployment with:

- one SQLite-backed Durable Object
- one logical singleton Durable Object instance, e.g. "global"
- Cloudflare Cron Triggers for periodic update checks
- Durable Object alarms for long-running backfills / ingestion queues
- Muse Spark 1.3 Contributor for document parsing and classification
- the existing simondean.xyz frontend stack where practical

Conceptually:

    Parliament of Australia
            |
            v
    Cloudflare Worker
      - public HTTP routes
      - API routes
      - scheduled() cron
            |
            v
    ParliamentaryDisclosures Durable Object
      - SQLite
      - ingestion queue
      - search
      - metadata
      - structured disclosures
      - classifications
      - editorial flags
            |
            v
         Muse API

No R2.
No D1.
No external search service unless later proven necessary.


SINGLETON DURABLE OBJECT
========================

Use one named Durable Object instance for the entire dataset.

Example:

    const id = env.PARLIAMENTARY_DISCLOSURES.idFromName("global");
    const stub = env.PARLIAMENTARY_DISCLOSURES.get(id);

The Durable Object should own:

- SQLite schema
- ingestion state
- source metadata
- source versions
- politicians
- disclosure events
- entities
- tags
- search index
- editorial metadata
- parser/version metadata
- job state
- update checks

The Worker can proxy reads/writes to the Durable Object.

Prefer simple architecture over premature sharding.


PRIMARY SOURCES
===============

Primary source: Parliament of Australia.

House of Representatives:
https://www.aph.gov.au/register

Senate:
https://www.aph.gov.au/Parliamentary_Business/Committees/Senate/Senators_Interests/Senators_Interests_Register

Historical registers:
discover and follow official Parliamentary links for previous parliaments and tabled Senate volumes.

Initial historical target:
43rd Parliament through current 48th Parliament.

Design the schema so earlier parliaments can be added later without schema changes.


INGESTION PHILOSOPHY
====================

The source PDF is temporary input.

Do not retain the PDF after processing.

For every source document we must retain enough provenance to reconstruct what we relied on:

- official source URL
- source title if available
- politician/member/senator
- chamber
- parliament number
- first seen timestamp
- last seen timestamp
- fetched timestamp
- HTTP ETag if available
- HTTP Last-Modified if available
- content length if available
- SHA-256 hash of fetched bytes
- parser/model name
- parser version
- schema version
- parse status
- count of extracted disclosure items

Each extracted disclosure must retain:

- exact original disclosure wording
- source document/version reference
- source page if available
- disclosure category
- event type
- relevant dates
- subject / relationship where applicable
- entities
- tags
- classification confidence
- manual verification state

Parliament remains the authoritative source.

Public UI should include a simple:

    View original source

link back to the official Parliamentary URL.

Do not provide or generate Archive.org links.
Do not store archived source copies ourselves.


SOURCE VERSIONING
=================

Treat each distinct fetched document as a version identified by SHA-256.

A URL may continue to point to a document that changes over time.

Example:

    source_url:
    https://www.aph.gov.au/.../member.pdf

Version A:
    fetched_at = ...
    sha256 = abc123...

Version B:
    fetched_at = ...
    sha256 = def456...

Both source versions must remain in the structured database.

Do not delete historical parsed records when Parliament updates the source URL.

The dataset should preserve the chronology of what was observed and parsed.

Suggested tables:

    sources
    source_versions

A source is the logical official URL/document identity.
A source_version is a particular fetched binary fingerprint and parse result.

Use a uniqueness rule approximately equivalent to:

    UNIQUE(source_id, sha256)


DOCUMENT FETCHING
=================

On ingestion:

1. fetch official document
2. capture HTTP metadata
3. read bytes in memory
4. compute SHA-256
5. check whether this source + SHA already exists
6. if already parsed successfully, skip
7. otherwise send document/text to parser
8. validate returned structured data
9. commit source version + parsed records transactionally
10. discard source bytes

Do not persist source PDFs.

If a PDF cannot be processed in one request due to runtime constraints, process it in the smallest practical temporary chunks while preserving the same source SHA and provenance.

Do not invent archival storage as a workaround unless explicitly required later.


MUSE PARSING LAYER
==================

Use Muse Spark 1.3 Contributor as the default parser.

The task is public-information extraction, so the low-cost Contributor tier is appropriate.

Important:
Muse is not the source of truth.
Muse is a transformation layer.

The source of truth is the official Parliamentary document and the exact extracted source wording.

Prefer direct PDF input where supported and reliable.

If direct PDF parsing is unreliable for a given document:
- extract embedded PDF text deterministically
- pass the extracted text into Muse
- use OCR only for genuinely scanned/image-only documents

Record extraction method.

Possible extraction_method values:

- direct_pdf_model
- embedded_pdf_text
- ocr
- manual

The parser should use low/minimal reasoning unless testing shows higher reasoning materially improves extraction quality.


PARSER BEHAVIOUR
================

The extraction prompt should be extremely strict.

Muse must:

- extract every disclosure item
- preserve the exact original wording
- preserve NIL / Not Applicable declarations where present
- preserve categories
- preserve additions, deletions, amendments and corrections as separate events
- preserve the person/relationship the disclosure concerns where the form supports this
- preserve relevant dates
- identify entities
- classify aviation-related records
- return strict schema-conforming JSON

Muse must NOT:

- summarise source wording instead of preserving it
- editorialise
- infer motives
- infer corruption
- infer whether a benefit was solicited
- infer whether a benefit was taxpayer funded
- infer market value unless explicitly stated
- infer whether an upgrade was requested unless source wording states it
- merge ambiguous additions and deletions
- silently omit boring or NIL records
- convert blank into NIL
- treat unknown as false
- invent missing information


STRICT JSON OUTPUT
==================

Define and enforce a schema.

Illustrative shape:

{
  "document": {
    "politician_name": "Catherine King",
    "chamber": "house",
    "parliament": 48,
    "document_type": "alteration",
    "lodged_date": "2026-09-10"
  },
  "disclosures": [
    {
      "category": "gifts",
      "event_type": "addition",
      "subject": "self",
      "disclosure_date": "2026-09-10",
      "raw_text": "EXACT SOURCE WORDING HERE",
      "page": 3,
      "entities": [
        {
          "name": "Qantas",
          "type": "airline"
        }
      ],
      "tags": [
        "aviation",
        "airline_status",
        "lifetime_status"
      ],
      "aviation": {
        "relevant": true,
        "type": "airline_status",
        "airline": "Qantas",
        "status_name": "Lifetime Platinum",
        "requested": null,
        "cabin_from": null,
        "cabin_to": null
      },
      "confidence": 0.98
    }
  ]
}

This is illustrative, not final.

Use an explicit JSON schema / structured output mechanism where supported.

Reject malformed output rather than silently coercing it into apparently valid data.


TWO DATA LAYERS
===============

Maintain a hard separation between:

1. source-derived records
2. our classification/editorial layer

SOURCE-DERIVED RECORD
---------------------

Contains only facts explicitly found in the Parliamentary source:

- exact source text
- category
- event type
- date
- subject
- page
- named entities if directly present
- source provenance

CLASSIFICATION / EDITORIAL LAYER
--------------------------------

May contain:

- tags
- aviation category
- normalized airline name
- normalized airport name
- editorial-interest score
- featured flag
- investigation notes
- manual annotations
- derived current-state interpretation

Never modify source-derived wording to fit classification.


DATA MODEL
==========

Use SQLite inside the Durable Object.

Suggested core tables:

politicians
-----------
id
slug
full_name
chamber
electorate
state
party
first_seen_at
last_seen_at
active

sources
-------
id
politician_id
parliament
chamber
source_url
source_title
first_seen_at
last_seen_at

source_versions
---------------
id
source_id
fetched_at
sha256
content_length
http_etag
http_last_modified
extraction_method
model
model_version
parser_version
schema_version
parse_status
parse_confidence
disclosure_count
error_summary

disclosures
-----------
id
source_version_id
politician_id
parliament
chamber
category
event_type
subject
disclosure_date
lodged_date
raw_text
raw_text_hash
source_page
parser_confidence
manually_verified
created_at

entities
--------
id
canonical_name
entity_type
slug

disclosure_entities
-------------------
disclosure_id
entity_id
role
confidence

tags
----
id
name
slug

disclosure_tags
---------------
disclosure_id
tag_id
confidence
source
manual_override

aviation_details
----------------
disclosure_id
aviation_type
airline_entity_id
airport_entity_id
status_name
lounge_name
cabin_from
cabin_to
requested
complimentary
sponsored
notes

editorial
---------
disclosure_id
featured
interesting
aviation_featured
needs_review
investigated
interest_score
editorial_note
updated_at

ingestion_jobs
--------------
id
job_type
source_id
source_url
status
attempts
created_at
started_at
completed_at
next_retry_at
last_error

parser_runs
-----------
id
source_version_id
model
model_version
parser_version
schema_version
started_at
completed_at
status
input_kind
error_summary


EVENT-BASED MODEL
=================

Treat disclosure changes as events, not as a single mutable snapshot.

Possible event_type values:

- initial
- addition
- deletion
- alteration
- amendment
- correction
- unknown

Do not silently reconcile a later deletion into a previous addition unless the match is unambiguous.

The canonical record should remain the event ledger.

A separate derived "current interests" view may be added later, but it must:

- be clearly marked as derived
- point back to source events
- retain uncertainty where matching is ambiguous
- be recomputable


HOUSE DISCLOSURE CATEGORIES
===========================

Normalize House categories while preserving original category labels if useful.

Expected broad categories include:

- shareholdings
- trusts_and_nominee_companies
- real_estate
- directorships
- partnerships
- liabilities
- bonds_and_debentures
- savings_and_investment_accounts
- other_assets
- other_income
- gifts
- sponsored_travel_or_hospitality
- memberships
- other_interests

Do not treat:
- NIL
- Not Applicable
- blank
- unavailable
- parser failure

as equivalent values.

Represent them distinctly.


SENATE
======

The Senate register differs structurally from the House register.

Do not force Senate records into House-specific semantics where those semantics do not exist.

Support a common top-level disclosure model while allowing Senate-specific metadata.

Historical Senate tabled volumes may contain multiple senators per PDF.

The parser must be able to split one source document into records belonging to different senators where necessary.

Retain the single source/version provenance for those records.


AVIATION CLASSIFICATION
=======================

Aviation is the main editorial lens, but parse everything.

Tags should include at minimum:

- aviation
- airline
- airport
- airline_status
- lifetime_status
- lounge_membership
- chairmans_lounge
- virgin_beyond
- flight_upgrade
- complimentary_upgrade
- complimentary_flight
- sponsored_flight
- charter
- private_aviation
- airport_parking
- airline_points
- travel_hospitality
- aircraft_manufacturer
- frequent_flyer

Recognize and normalize aviation entities including:

- Qantas
- Virgin Australia
- Emirates
- Qatar Airways
- Singapore Airlines
- Air New Zealand
- Rex
- Jetstar
- major Australian airports
- other airlines and aviation companies as discovered

Do not limit aviation classification to a fixed hardcoded entity list.

Preserve the original entity name and map to a canonical entity separately.


GENERAL CLASSIFICATION
======================

The full database should remain useful beyond aviation.

Useful general themes may include:

- property
- financial interests
- shares
- trusts
- directorships
- gifts
- travel
- hospitality
- sport
- tickets
- media
- corporate
- foreign governments
- lobby groups
- unions
- charities
- memberships

Do not overcomplicate the first version.

Aviation is the priority.
Everything else should remain searchable even when not richly classified.


VALIDATION
==========

Build deterministic validation around model output.

At minimum:

- schema validation
- required fields
- valid event/category enums
- valid politician attribution
- source/version linkage
- reject impossible dates
- reject malformed JSON
- deduplicate repeated model outputs

Where practical, verify that raw_text is present in or closely matches extracted source text.

For direct multimodal PDF parsing where exact text extraction is not available, retain a confidence level and route uncertain results to review.

Use a raw_text_hash to help deduplicate records.

Recommended uniqueness strategy:

source version + category + event type + raw_text_hash + politician

Do not rely solely on a model-generated identifier.


CONFIDENCE ESCALATION
=====================

Default path:

Muse Spark 1.3 Contributor
        |
        v
high-confidence valid result
        |
        v
accept

If validation fails or confidence is low:

1. retry once with a stricter prompt / extraction mode
2. optionally use a stronger model if configured
3. if still uncertain, mark needs_review

Do not silently accept uncertain records.


BACKFILL
========

Implement a full historical backfill from the 43rd Parliament through the current Parliament.

Do not try to perform the entire backfill in one Worker request.

Use the Durable Object's SQLite table + alarms as a persistent ingestion queue.

Example flow:

POST /api/admin/backfill
    |
    v
discover official sources
    |
    v
insert ingestion_jobs
    |
    v
schedule DO alarm

Each alarm invocation should:

1. claim a small batch of pending jobs
2. fetch sources
3. hash documents
4. skip already-known versions
5. parse new versions
6. validate
7. transactionally commit records
8. update job state
9. schedule next alarm if work remains

Keep batches conservative.

Correctness and recoverability matter more than finishing quickly.


IDEMPOTENCY
===========

All ingestion must be safe to rerun.

Important uniqueness rules:

- source URL + parliament/chamber identifies logical source
- source_id + SHA-256 identifies a unique source version
- parser runs should be versioned
- duplicate disclosure records must not be inserted twice

If an alarm runs twice, no duplicate records should appear.

If the deployment restarts halfway through a backfill, processing should resume from persisted SQLite state.


UPDATE SCHEDULE
===============

Do not update only annually.

Use a lightweight recurring discovery job.

Recommended:

- daily or weekly index check
- annual full reconciliation

Daily/weekly check:

1. fetch House/Senate register indexes
2. update politician/source metadata
3. detect new or changed source documents
4. create ingestion jobs only for new or changed items
5. run Muse only when a new source version is detected

Annual reconciliation:

- revisit all known official sources
- verify source URLs
- re-check hashes
- find missing/new historical items
- optionally reprocess with a newer parser/schema if explicitly configured

Model cost should be close to zero when nothing changes.


CRON + ALARMS
=============

Use Cloudflare Cron Triggers to wake the Worker periodically.

Use Durable Object alarms to process queued ingestion work over multiple invocations.

The cron handler should not itself attempt to parse the full corpus.

Suggested pattern:

scheduled()
    -> get singleton DO
    -> ask DO to run discovery/update check
    -> DO creates jobs
    -> DO schedules alarm
    -> alarm processes batches until queue empty


SEARCH
======

Implement full-text search using SQLite FTS5 inside the Durable Object if supported by current Cloudflare SQLite runtime.

Search should work across:

- exact disclosure wording
- politician names
- electorate/state
- entities
- tags
- normalized aviation details

Queries that should work well:

- Qantas
- Virgin
- Lifetime Platinum
- Chairman's Lounge
- upgrade
- unrequested upgrade
- airport parking
- Emirates
- sponsored travel
- lounge membership

Support filters for:

- politician
- party
- chamber
- parliament
- year
- category
- event type
- entity
- tag
- aviation type
- airline
- manually verified
- featured


PUBLIC SITE
===========

Primary route:

    /parliamentary-disclosures

The landing page should feel editorial, not like raw database administration.

Suggested top-level sections:

- Search Parliamentary Disclosures
- Aviation
- Latest disclosures
- Featured / interesting disclosures
- Browse politicians
- Browse entities
- Browse categories

The database is complete underneath.
The public homepage should surface the interesting material.


AVIATION PAGE
=============

Create:

    /parliamentary-disclosures/aviation

This should be a strong editorial/research page.

Potential modules:

- latest aviation disclosures
- airline status disclosures
- lifetime status disclosures
- lounge memberships
- flight upgrades
- complimentary flights
- sponsored aviation travel
- airport benefits
- airport parking
- Qantas disclosures
- Virgin Australia disclosures
- other airline disclosures
- most frequently appearing aviation entities
- politicians with multiple aviation-related disclosures

Support filters.

Do not turn correlations into accusations.


POLITICIAN PAGES
================

Create pages like:

    /parliamentary-disclosures/catherine-king

Show:

- name
- chamber
- electorate/state
- party where reliable
- parliament(s)
- chronological disclosure timeline
- categories
- aviation disclosures highlighted
- additions/deletions visually distinguished
- exact source wording
- "View original source" link
- source access date
- optional parser verification indicator

Do not clutter the public UI with implementation details unless useful.

The user should always be able to reach the original official source.


ENTITY PAGES
============

Create pages such as:

    /parliamentary-disclosures/entities/qantas
    /parliamentary-disclosures/entities/virgin-australia

Show:

- entity name
- entity type
- total disclosure events
- politicians involved
- timeline
- relevant categories
- aviation subtypes
- exact source wording for entries

This makes the database useful for research.


DISCLOSURE DETAIL
=================

Each disclosure result/detail should show:

- politician
- date
- category
- event type
- exact original wording
- recognized entities
- relevant tags
- source link

Preferred wording in UI:

- declared
- disclosed
- listed
- recorded

Avoid wording such as:
- accepted
- received
- solicited
- was gifted

unless the source explicitly supports that interpretation.


EDITORIAL LAYER
===============

Add an internal editorial workflow.

Allow fields:

- featured
- interesting
- aviation_featured
- needs_review
- investigated
- interest_score 1-10
- editorial_note

Editorial note must be visually distinct from source text.

Never overwrite source wording with editorial commentary.


ADMIN / REVIEW UI
=================

Create a protected admin interface.

Suggested routes:

    /parliamentary-disclosures/admin

Views:

- new ingestion jobs
- failed jobs
- low-confidence records
- parser failures
- records needing review
- new aviation records
- high-interest records
- possible duplicates
- recently changed documents
- parser/schema version stats

Allow:

- manual verification
- tag edits
- canonical entity corrections
- aviation subtype correction
- editorial interest score
- featured flags
- editorial notes
- reparse source version
- retry failed ingestion

Do not allow manual editing of raw source wording without preserving the original parser result and an explicit correction history.


CHANGE DETECTION
================

The system should detect changes efficiently.

Use:

- source index last-updated fields where available
- ETag
- Last-Modified
- content length
- SHA-256

SHA-256 is authoritative for binary change detection.

Do not invoke Muse when a fetched source has a SHA already known for that source.


SOURCE ACCESS RECORD
====================

For provenance, public-facing source metadata may include:

- official source title
- official source URL
- accessed/fetched date
- parliament/chamber

Internally also retain:

- SHA-256
- HTTP metadata
- model/parser version
- parse timestamps
- parse confidence

No Archive.org integration.
No source mirroring.
No stored PDF download.


METHODOLOGY PAGE
================

Create:

    /parliamentary-disclosures/methodology

Explain clearly:

- records are derived from official Parliament of Australia disclosures
- Parliament remains the authoritative source
- source files are fetched and parsed but not archived by this site
- exact disclosure wording is retained in structured records
- AI is used to structure and classify records
- classifications are separate from official source wording
- errors are possible
- users should consult the original Parliamentary source
- additions/deletions are preserved as events
- derived current-state views may contain interpretation
- blank, NIL, Not Applicable and unknown are treated differently
- corrections can be submitted/contacted through the site's normal mechanism

Keep this clear and non-defensive.


API
===

Expose read-only public API routes if useful.

Examples:

    GET /api/parliamentary-disclosures/search?q=qantas
    GET /api/parliamentary-disclosures/politicians/catherine-king
    GET /api/parliamentary-disclosures/entities/qantas
    GET /api/parliamentary-disclosures/aviation
    GET /api/parliamentary-disclosures/latest

Admin endpoints must be protected.

Potential admin endpoints:

    POST /api/admin/parliamentary-disclosures/discover
    POST /api/admin/parliamentary-disclosures/backfill
    POST /api/admin/parliamentary-disclosures/reparse/:sourceVersionId
    POST /api/admin/parliamentary-disclosures/retry/:jobId


PERFORMANCE
===========

A single DO should be sufficient initially.

Cache public responses aggressively because disclosure data changes slowly.

Possible cache approach:

- short browser TTL
- longer edge cache
- purge/bust relevant cache keys after ingestion commits

Do not add distributed complexity unless traffic or data size proves it necessary.


EXPECTED SCALE
==============

Rough initial assumptions:

- approximately 1,000 source documents for modern parliamentary history in scope
- tens of thousands of structured disclosure rows
- possibly 50,000-100,000+ records after full historical ingestion
- well within a single SQLite Durable Object's expected storage capacity

Do not optimize for millions of PDFs.


SEO
===

Make public pages server-renderable/indexable where appropriate.

Useful pages should have stable canonical URLs.

Examples:

    /parliamentary-disclosures
    /parliamentary-disclosures/aviation
    /parliamentary-disclosures/catherine-king
    /parliamentary-disclosures/anthony-albanese
    /parliamentary-disclosures/entities/qantas

Metadata should describe the site as a searchable index of Australian federal parliamentary disclosures.

Do not use sensational metadata.


DESIGN
======

Follow the existing simondean.xyz visual system.

The page should feel:

- clean
- editorial
- investigative
- readable
- slightly data-journalistic
- not bureaucratic
- not partisan

Prioritize:

- search
- timelines
- exact source wording
- clear tags
- obvious source links
- strong aviation surfaces

Avoid giant enterprise-dashboard aesthetics.


AVIATION HOME MODULE IDEAS
==========================

Potential cards:

Lifetime airline status
-----------------------
Politicians who have disclosed lifetime airline status.

Lounge memberships
------------------
Chairman's Lounge, Virgin Beyond and similar disclosures.

Upgrades
--------
Business / First upgrades, including explicitly "unrequested" upgrades where disclosed.

Airline entities
----------------
Qantas, Virgin Australia, Emirates, Qatar Airways, etc.

Airports
--------
Airport parking, hospitality, access and other perks.

Latest
------
Most recently added aviation-related disclosures.

Interesting
-----------
Manually curated disclosures with context.

Do not hardcode statistics until the dataset supports them.


DERIVED ANALYTICS
=================

Once enough data is ingested, support derived stats such as:

- number of MPs with an aviation-related disclosure
- number with airline lounge memberships
- number with lifetime airline status
- number of upgrade disclosures
- Qantas vs Virgin disclosure counts
- most common aviation entities
- aviation disclosures by parliament
- aviation disclosures by chamber
- disclosure trends over time

Always make clear that these are counts of disclosed records, not proof of usage/value/solicitation.


CURRENT-STATE VIEW
==================

Do not make current-state reconstruction part of the canonical ingest.

If implemented, derive separately from the event ledger.

Example:

    "Currently declared interests"

must be labeled as a derived interpretation.

Ambiguous deletions should remain unresolved or require manual review.


TESTING
=======

Before full ingestion, validate the system against a representative sample.

At minimum include:

- Catherine King
- Anthony Albanese
- one member with multiple alterations
- one mostly-NIL statement
- one scanned or awkward PDF if available
- one Senate source
- one Senate historical volume containing multiple senators

Tests should cover:

- source discovery
- SHA hashing
- duplicate source detection
- structured Muse output
- schema rejection
- retries
- exact raw_text preservation
- additions/deletions
- entity normalization
- aviation tagging
- FTS search
- alarm resume after failure
- idempotent backfill
- reprocessing with a new parser version


PARSER VERSIONING
=================

All parsing should be versioned.

At minimum record:

- model
- model version if available
- parser prompt version
- JSON schema version

When parser logic changes, do not destroy previous provenance.

Support reprocessing a known source version with a newer parser/schema if required.

The source version remains linked to the same SHA.


ERROR HANDLING
==============

Prefer unknown to unjustified inference.

Possible parse statuses:

- pending
- parsing
- success
- success_needs_review
- failed_fetch
- failed_parse
- failed_validation
- manual_review

Jobs should have bounded retries.

Persist useful error summaries.


SECURITY
========

Protect all ingestion/admin endpoints.

Keep Muse API credentials in Worker secrets.

Do not expose secrets or raw admin controls publicly.

Public API should be read-only.


IMPLEMENTATION ORDER
====================

Do not build the entire UI before validating ingestion.

Recommended sequence:

PHASE 1
-------
- inspect existing simondean.xyz repo
- create Worker/DO bindings
- create SQLite schema
- create migrations
- build House current-register discovery
- fetch one PDF
- hash it
- parse it through Muse
- store exact disclosure records
- expose a simple debug endpoint

PHASE 2
-------
- validate 5+ diverse House records
- improve schema and parser
- add Senate handling
- add source versions
- add entities/tags
- add validation
- add FTS5 search

PHASE 3
-------
- build persistent ingestion queue
- add DO alarms
- build full 43rd-48th backfill
- make ingestion idempotent
- add cron discovery/update checks

PHASE 4
-------
- public search UI
- politician pages
- aviation page
- entity pages
- latest disclosures
- methodology page

PHASE 5
-------
- admin review tools
- editorial flags
- low-confidence queue
- featured disclosures
- analytics modules

PHASE 6
-------
- SEO polish
- caching
- accessibility
- performance
- final historical completeness audit


IMPORTANT PRODUCT PRINCIPLES
============================

1. PARLIAMENT IS THE SOURCE
---------------------------
Always link back to the official source.

2. DO NOT BECOME AN ARCHIVE
---------------------------
Do not store PDFs.
Do not add R2.
Do not integrate Archive.org.

3. KEEP EXACT WORDING
---------------------
The exact source disclosure text is essential.

4. CLASSIFICATION IS SEPARATE
-----------------------------
Our interpretation must never overwrite the official wording.

5. EVENT LEDGER FIRST
---------------------
Additions, deletions and corrections remain historical events.

6. PARSE EVERYTHING
-------------------
Do not only ingest aviation records.
Aviation is the main editorial surface, not the ingestion filter.

7. AI IS A PARSER, NOT AN AUTHORITY
-----------------------------------
Muse turns source documents into structure.
It does not determine truth beyond what is disclosed.

8. PROVENANCE EVERYWHERE
------------------------
Every row must trace back to a source URL and source version.

9. MAKE IT CHEAP AND BORING
---------------------------
One Worker.
One Durable Object.
SQLite.
Muse.
No unnecessary infrastructure.

10. MAKE THE PUBLIC SIDE INTERESTING
------------------------------------
The database should be comprehensive.
The public landing experience should surface the genuinely interesting disclosures, especially aviation.


INITIAL SUCCESS CRITERIA
========================

The first meaningful milestone is:

- current House register discovered automatically
- at least 5 substantially different member PDFs parsed through Muse
- exact raw source wording stored
- source URL + fetch timestamp + SHA stored
- disclosures queryable in SQLite
- Qantas search works
- aviation-tagged records can be filtered
- Catherine King page renders correctly
- Anthony Albanese page renders correctly
- original Parliamentary source links are visible
- no source PDFs are stored permanently

The next milestone is:

- entire current Parliament parsed
- Senate supported
- full historical 43rd-48th backfill running through the DO alarm queue
- public searchable interface live


FINAL NOTE TO IMPLEMENTING AGENT
================================

Before making large architectural changes, inspect the existing simondean.xyz repository and reuse its conventions wherever practical.

Do not introduce D1, R2, external queues, external search engines or extra services unless there is a concrete technical blocker that cannot reasonably be solved with the architecture above.

If a blocker exists, document:
- the blocker
- why the current architecture cannot solve it
- the smallest proposed addition

Then implement the smallest solution.

Bias toward a small, legible, durable system.
