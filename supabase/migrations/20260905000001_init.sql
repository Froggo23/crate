-- CRATE: core schema
-- A query engine for music discovery that understands theory, not just popularity.

create extension if not exists vector;
create extension if not exists pg_trgm;
create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- artists
-- ---------------------------------------------------------------------------
create table if not exists artists (
  id                      uuid primary key default gen_random_uuid(),
  source                  text not null,                -- 'archive' | 'jamendo'
  source_key              text not null unique,         -- stable per-source identity
  name                    text not null,
  name_norm               text generated always as (lower(btrim(name))) stored,

  -- MusicBrainz join layer
  mbid                    uuid,
  mb_country              text,
  mb_type                 text,
  mb_begin_year           int,

  -- popularity / emergence inputs  (section 2.2)
  listenbrainz_listens    bigint,
  listenbrainz_listeners  bigint,
  deezer_id               bigint,
  deezer_rank             int,
  deezer_fans             int,
  catalog_size            int    not null default 0,
  first_release_year      int,
  label                   text,
  label_size              int,

  pop_raw_cache           double precision,   -- cached popularity aggregate
  emergence_score         double precision,   -- 0..1 raw, higher = more emerging
  emergence_percentile    double precision,   -- 0..100, LOW = obscure
  enriched_at             timestamptz,
  created_at              timestamptz not null default now()
);
create index if not exists artists_name_trgm    on artists using gin (name_norm gin_trgm_ops);
create index if not exists artists_emergence    on artists (emergence_percentile);
create index if not exists artists_mbid         on artists (mbid);

-- ---------------------------------------------------------------------------
-- tracks
-- ---------------------------------------------------------------------------
create table if not exists tracks (
  id                 uuid primary key default gen_random_uuid(),
  artist_id          uuid not null references artists(id) on delete cascade,
  source             text not null,
  source_key         text not null unique,
  title              text not null,
  album              text,
  year               int,
  duration_sec       double precision,
  audio_url          text not null,
  page_url           text,
  license_url        text,
  license_short      text,
  artwork_url        text,
  tags               text[] not null default '{}',
  mb_recording_mbid  uuid,

  analyzed           boolean not null default false,
  analysis_error     text,
  embedded           boolean not null default false,
  created_at         timestamptz not null default now()
);
create index if not exists tracks_artist     on tracks (artist_id);
create index if not exists tracks_analyzed   on tracks (analyzed) where analyzed = false;
create index if not exists tracks_embedded   on tracks (embedded) where embedded = false;
create index if not exists tracks_tags       on tracks using gin (tags);
create index if not exists tracks_title_trgm on tracks using gin (lower(title) gin_trgm_ops);
create index if not exists tracks_year       on tracks (year);

-- ---------------------------------------------------------------------------
-- audio_features  -- output of the CRATE DSP pipeline (lib/dsp)
-- ---------------------------------------------------------------------------
create table if not exists audio_features (
  track_id             uuid primary key references tracks(id) on delete cascade,

  -- rhythm
  bpm                  double precision,
  bpm_confidence       double precision,
  onset_rate           double precision,
  beat_strength        double precision,

  -- tonal  (section 2.1)
  hpcp                 double precision[],   -- 12, global harmonic pitch class profile
  hpcp_bass            double precision[],   -- 12, < 250 Hz  (bass-register weighting)
  hpcp_downbeat        double precision[],   -- 12, downbeat-weighted
  tonic                int,                  -- 0..11 pitch class, 0 = C
  tonic_confidence     double precision,
  mode                 text,                 -- ionian..locrian | harmonic_minor | phrygian_dominant | whole_tone | unclear
  mode_confidence      double precision,
  mode_scores          jsonb,                -- every template correlation, for transparency
  key_name             text,                 -- 'E Phrygian'
  flat2_evidence       double precision,     -- the Phrygian diagnostic tell

  -- baseline: Krumhansl-Schmuckler / Temperley, collapsed to major|minor
  baseline_key         int,
  baseline_mode        text,
  baseline_key_name    text,
  baseline_correlation double precision,

  -- timbre / dynamics
  rms                  double precision,
  loudness_db          double precision,
  crest_factor         double precision,
  dynamic_range_db     double precision,
  spectral_centroid    double precision,
  spectral_rolloff     double precision,
  spectral_flatness    double precision,
  spectral_bandwidth   double precision,
  spectral_flux        double precision,
  zcr                  double precision,
  hf_ratio             double precision,
  lf_ratio             double precision,
  percussive_ratio     double precision,
  mfcc                 double precision[],   -- 26 = 13 mean + 13 std

  -- derived, user-facing
  instrumental_likelihood double precision,
  energy                  double precision,
  brightness              double precision,

  analyzer_version     text,
  analyzed_at          timestamptz not null default now()
);
create index if not exists af_bpm      on audio_features (bpm);
create index if not exists af_mode     on audio_features (mode);
create index if not exists af_tonic    on audio_features (tonic);
create index if not exists af_energy   on audio_features (energy);
create index if not exists af_instr    on audio_features (instrumental_likelihood);

-- ---------------------------------------------------------------------------
-- embeddings
-- ---------------------------------------------------------------------------
create table if not exists track_embeddings (
  track_id       uuid primary key references tracks(id) on delete cascade,
  text_vec       vector(1536),   -- OpenAI text-embedding-3-small over the generated audio card
  descriptor_vec vector(64),     -- L2-normalised DSP descriptor
  clap_vec       vector(512),    -- reserved: LAION-CLAP, filled by scripts/clap_embed.py
  card           text,
  updated_at     timestamptz not null default now()
);
create index if not exists te_text_hnsw on track_embeddings using hnsw (text_vec vector_cosine_ops);
create index if not exists te_desc_hnsw on track_embeddings using hnsw (descriptor_vec vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- evaluation: hand-labelled ground truth  (section 5, phase 1)
-- ---------------------------------------------------------------------------
create table if not exists mode_labels (
  track_id      uuid primary key references tracks(id) on delete cascade,
  labeled_tonic int  not null,
  labeled_mode  text not null,
  labeler       text not null default 'anon',
  confidence    int  not null default 3,   -- 1..5, the labeller's own certainty
  notes         text,
  created_at    timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- the accumulating relevance dataset  (section 2.3 -- the long-term moat)
-- ---------------------------------------------------------------------------
create table if not exists queries (
  id            uuid primary key default gen_random_uuid(),
  session_id    text not null,
  raw_text      text not null,
  parsed        jsonb not null,
  parse_ms      int,
  retrieve_ms   int,
  rerank_ms     int,
  provider      text,
  model         text,
  candidate_count int,
  result_count  int,
  created_at    timestamptz not null default now()
);
create index if not exists queries_session on queries (session_id, created_at desc);

create table if not exists query_results (
  id              bigserial primary key,
  query_id        uuid not null references queries(id) on delete cascade,
  track_id        uuid not null references tracks(id) on delete cascade,
  rank            int not null,
  pre_rerank_rank int,
  vector_distance double precision,
  reason          text,
  created_at      timestamptz not null default now()
);
create index if not exists qr_query on query_results (query_id, rank);

create table if not exists relevance_events (
  id         bigserial primary key,
  query_id   uuid references queries(id) on delete set null,
  track_id   uuid not null references tracks(id) on delete cascade,
  session_id text not null,
  event      text not null check (event in ('up','down','play','skip','save')),
  position   int,
  dwell_ms   int,
  created_at timestamptz not null default now()
);
create index if not exists re_track on relevance_events (track_id);
create index if not exists re_query on relevance_events (query_id);

-- ---------------------------------------------------------------------------
-- ingestion bookkeeping (resumable crawls) + rate limiting
-- ---------------------------------------------------------------------------
create table if not exists ingest_state (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

create table if not exists rate_limits (
  bucket       text not null,
  window_start timestamptz not null,
  count        int not null default 0,
  primary key (bucket, window_start)
);

-- ---------------------------------------------------------------------------
-- RLS: deny-all to anon/authenticated. All access is server-side via
-- service_role (which bypasses RLS) or the pooled Postgres connection.
-- ---------------------------------------------------------------------------
alter table artists          enable row level security;
alter table tracks           enable row level security;
alter table audio_features   enable row level security;
alter table track_embeddings enable row level security;
alter table mode_labels      enable row level security;
alter table queries          enable row level security;
alter table query_results    enable row level security;
alter table relevance_events enable row level security;
alter table ingest_state     enable row level security;
alter table rate_limits      enable row level security;
