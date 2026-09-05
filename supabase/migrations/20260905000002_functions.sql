-- CRATE: retrieval + scoring functions

-- ---------------------------------------------------------------------------
-- crate_search
--
-- The single most important design decision in the system (plan section 3, [2]):
-- HARD CONSTRAINTS ARE APPLIED FIRST, IN SQL, AND VECTOR SIMILARITY ONLY EVER
-- REORDERS WHAT SURVIVED THAT FILTER. Semantic similarity can never promote a
-- vocal track into a "no vocals" query, no matter how well it matches the vibe.
-- This is enforced structurally by the CTE boundary, not by convention.
-- ---------------------------------------------------------------------------
create or replace function crate_search(
  q_vec             vector(1536)     default null,
  p_desc_vec        vector(64)       default null,
  p_desc_weight     double precision default 0.0,
  p_bpm_min         double precision default null,
  p_bpm_max         double precision default null,
  p_tonics          int[]            default null,
  p_modes           text[]           default null,
  p_year_min        int              default null,
  p_year_max        int              default null,
  p_instrumental    boolean          default null,
  p_emergence_max   double precision default null,
  p_energy_min      double precision default null,
  p_energy_max      double precision default null,
  p_brightness_min  double precision default null,
  p_brightness_max  double precision default null,
  p_duration_min    double precision default null,
  p_duration_max    double precision default null,
  p_tags_any        text[]           default null,
  p_text            text             default null,
  p_min_mode_conf   double precision default null,
  p_exclude         uuid[]           default null,
  p_limit           int              default 50
)
returns table (
  track_id                uuid,
  title                   text,
  artist_id               uuid,
  artist_name             text,
  album                   text,
  year                    int,
  duration_sec            double precision,
  audio_url               text,
  page_url                text,
  license_short           text,
  license_url             text,
  artwork_url             text,
  tags                    text[],
  bpm                     double precision,
  bpm_confidence          double precision,
  tonic                   int,
  mode                    text,
  mode_confidence         double precision,
  key_name                text,
  baseline_key_name       text,
  mode_scores             jsonb,
  hpcp                    double precision[],
  energy                  double precision,
  brightness              double precision,
  instrumental_likelihood double precision,
  loudness_db             double precision,
  spectral_centroid       double precision,
  spectral_flatness       double precision,
  percussive_ratio        double precision,
  emergence_percentile    double precision,
  listenbrainz_listens    bigint,
  distance                double precision
)
language sql
stable
as $$
  with filtered as (
    -- ==== HARD CONSTRAINT GATE =============================================
    select t.id as tid
    from tracks t
    join audio_features f on f.track_id = t.id
    join artists       a on a.id        = t.artist_id
    where t.analyzed
      and t.embedded
      and (p_bpm_min        is null or f.bpm  >= p_bpm_min)
      and (p_bpm_max        is null or f.bpm  <= p_bpm_max)
      and (p_tonics         is null or f.tonic = any(p_tonics))
      and (p_modes          is null or f.mode  = any(p_modes))
      and (p_min_mode_conf  is null or f.mode_confidence >= p_min_mode_conf)
      and (p_year_min       is null or t.year >= p_year_min)
      and (p_year_max       is null or t.year <= p_year_max)
      and (p_duration_min   is null or t.duration_sec >= p_duration_min)
      and (p_duration_max   is null or t.duration_sec <= p_duration_max)
      and (p_energy_min     is null or f.energy     >= p_energy_min)
      and (p_energy_max     is null or f.energy     <= p_energy_max)
      and (p_brightness_min is null or f.brightness >= p_brightness_min)
      and (p_brightness_max is null or f.brightness <= p_brightness_max)
      and (p_instrumental   is null
           or (p_instrumental      and f.instrumental_likelihood >= 0.60)
           or (not p_instrumental  and f.instrumental_likelihood <= 0.45))
      and (p_emergence_max  is null or a.emergence_percentile is null
           or a.emergence_percentile <= p_emergence_max)
      and (p_tags_any       is null or t.tags && p_tags_any)
      and (p_exclude        is null or not (t.id = any(p_exclude)))
      and (p_text is null or p_text = '' or
           lower(t.title) like '%' || lower(p_text) || '%' or
           a.name_norm    like '%' || lower(p_text) || '%' or
           exists (select 1 from unnest(t.tags) g where lower(g) like '%' || lower(p_text) || '%'))
  )
  -- ==== SEMANTIC RE-ORDERING, WITHIN THE SURVIVORS ONLY ====================
  select
    t.id, t.title, a.id, a.name, t.album, t.year, t.duration_sec,
    t.audio_url, t.page_url, t.license_short, t.license_url, t.artwork_url, t.tags,
    f.bpm, f.bpm_confidence, f.tonic, f.mode, f.mode_confidence, f.key_name,
    f.baseline_key_name, f.mode_scores, f.hpcp,
    f.energy, f.brightness, f.instrumental_likelihood, f.loudness_db,
    f.spectral_centroid, f.spectral_flatness, f.percussive_ratio,
    a.emergence_percentile, a.listenbrainz_listens,
    case
      when q_vec is null and p_desc_vec is null then null
      when q_vec is null      then (te.descriptor_vec <=> p_desc_vec)
      when p_desc_vec is null then (te.text_vec       <=> q_vec)
      else (1.0 - p_desc_weight) * (te.text_vec       <=> q_vec)
         +        p_desc_weight  * (te.descriptor_vec <=> p_desc_vec)
    end as distance
  from filtered
  join tracks           t  on t.id  = filtered.tid
  join audio_features   f  on f.track_id = t.id
  join artists          a  on a.id  = t.artist_id
  join track_embeddings te on te.track_id = t.id
  order by distance asc nulls last,
           a.emergence_percentile asc nulls last,
           f.mode_confidence desc nulls last
  limit greatest(1, least(p_limit, 200));
$$;

-- ---------------------------------------------------------------------------
-- refresh_emergence
--
-- Section 2.2: obscurity is a first-class ranking objective, not a penalty.
-- We build a POPULARITY score, then expose its percentile so the UI can set a
-- ceiling ("emerging only" = no artist above the 20th percentile).
--
--   nl(x)       = ln(1+x) normalised to [0,1] across the corpus
--   age_factor  = min(1, days_since_first_release / 3650)
--   pop_raw     = (0.55*nl(listens) + 0.20*nl(fans)
--                + 0.15*nl(catalog) + 0.10*nl(label_size))
--                * (0.6 + 0.4*age_factor)
--
-- The age term is why a brand-new artist with moderate listens still reads as
-- emerging: recent arrivals have their popularity discounted by up to 40%.
-- ---------------------------------------------------------------------------
create or replace function refresh_emergence()
returns integer
language plpgsql
as $$
declare
  n integer;
begin
  with bounds as (
    select
      greatest(max(ln(1 + coalesce(listenbrainz_listens,0)::double precision)), 1e-9) as m_listens,
      greatest(max(ln(1 + coalesce(deezer_fans,0)::double precision)),          1e-9) as m_fans,
      greatest(max(ln(1 + coalesce(catalog_size,0)::double precision)),         1e-9) as m_cat,
      greatest(max(ln(1 + coalesce(label_size,0)::double precision)),           1e-9) as m_label
    from artists
  ),
  scored as (
    select
      a.id,
      (
        ( 0.55 * ln(1 + coalesce(a.listenbrainz_listens,0)::double precision) / b.m_listens
        + 0.20 * ln(1 + coalesce(a.deezer_fans,0)::double precision)          / b.m_fans
        + 0.15 * ln(1 + coalesce(a.catalog_size,0)::double precision)         / b.m_cat
        + 0.10 * ln(1 + coalesce(a.label_size,0)::double precision)           / b.m_label
        )
        * ( 0.6 + 0.4 * least(1.0,
              greatest(0.0, (extract(epoch from now())/86400.0
                             - (coalesce(a.first_release_year, extract(year from now())::int) - 1970) * 365.25
                            ) / 3650.0)) )
      ) as pop_raw
    from artists a cross join bounds b
  ),
  ranked as (
    select id, pop_raw,
           100.0 * percent_rank() over (order by pop_raw asc) as pct
    from scored
  )
  update artists a
     set pop_raw_cache        = r.pop_raw,
         emergence_score      = 1.0 - r.pop_raw,
         emergence_percentile = r.pct
    from ranked r
   where a.id = r.id;

  get diagnostics n = row_count;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- rate limiting (Postgres-backed; no external Redis dependency)
-- ---------------------------------------------------------------------------
create or replace function bump_rate_limit(
  p_bucket text, p_limit int, p_window_seconds int
) returns boolean
language plpgsql
as $$
declare
  w timestamptz;
  c int;
begin
  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  insert into rate_limits (bucket, window_start, count)
       values (p_bucket, w, 1)
  on conflict (bucket, window_start)
       do update set count = rate_limits.count + 1
    returning count into c;
  delete from rate_limits where window_start < now() - interval '1 day';
  return c <= p_limit;
end;
$$;

-- ---------------------------------------------------------------------------
-- corpus_stats: powers the landing page + the honesty panel
-- ---------------------------------------------------------------------------
create or replace view corpus_stats as
select
  (select count(*) from tracks)                                    as tracks_total,
  (select count(*) from tracks where analyzed)                     as tracks_analyzed,
  (select count(*) from tracks where embedded)                     as tracks_embedded,
  (select count(*) from artists)                                   as artists_total,
  (select count(*) from mode_labels)                               as labeled_total,
  (select count(*) from queries)                                   as queries_total,
  (select count(*) from relevance_events)                          as feedback_total,
  (select round(avg(bpm)::numeric,1) from audio_features)          as mean_bpm,
  (select count(*) from audio_features where mode = 'unclear')     as mode_unclear,
  (select round((100.0*count(*) filter (where mode <> 'unclear')
                 / nullif(count(*),0))::numeric,1) from audio_features) as mode_decided_pct,
  (select round(avg(listenbrainz_listens)::numeric,0) from artists) as mean_listens;
