-- Adaptive fast path for unconstrained queries.
--
-- The gate exists to guarantee filter-first retrieval, and it must stay for any
-- query that actually has hard constraints. But when a query has NONE -- a pure
-- vibe search, which is the common case -- the gate is a 3-way join over the
-- whole corpus that admits every row, and it blocks the HNSW index for no
-- benefit. Measured on 22k rows on a nano instance:
--
--   HNSW index scan, no join, no gate        11 ms
--   gated path, no constraints set        9,397 ms
--
-- So: branch. No constraints -> let the index do its job. Any constraint at all
-- -> the gate, unchanged, because correctness outranks latency and a
-- vector-first search would silently drop valid matches outside the approximate
-- neighbourhood.
--
-- The fast path still applies analyzed/embedded, but AFTER the top-N rather than
-- before it, so it over-fetches 5x to absorb any rows dropped there. Those flags
-- are true for essentially the whole corpus, which is what makes that safe; the
-- gated path makes no such assumption.

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
  p_limit           int              default 50,
  p_tags_boost      text[]           default null,
  p_tags_weight     double precision default 0.14
)
returns table (
  track_id uuid, title text, artist_id uuid, artist_name text, album text, year int,
  duration_sec double precision, audio_url text, page_url text, license_short text,
  license_url text, artwork_url text, tags text[], bpm double precision,
  bpm_confidence double precision, tonic int, mode text, mode_confidence double precision,
  key_name text, baseline_key_name text, mode_scores jsonb, hpcp double precision[],
  energy double precision, brightness double precision, instrumental_likelihood double precision,
  loudness_db double precision, spectral_centroid double precision, spectral_flatness double precision,
  percussive_ratio double precision, emergence_percentile double precision,
  listenbrainz_listens bigint, distance double precision, tag_overlap double precision
)
language plpgsql
stable
as $$
declare
  n int := greatest(1, least(p_limit, 200));
  has_filters boolean := (
    p_bpm_min is not null or p_bpm_max is not null or p_tonics is not null or
    p_modes is not null or p_min_mode_conf is not null or p_year_min is not null or
    p_year_max is not null or p_duration_min is not null or p_duration_max is not null or
    p_energy_min is not null or p_energy_max is not null or p_brightness_min is not null or
    p_brightness_max is not null or p_instrumental is not null or p_emergence_max is not null or
    p_tags_any is not null or p_exclude is not null or (p_text is not null and p_text <> '')
  );
begin
  if not has_filters and q_vec is not null then
    -- ---- FAST PATH: nothing to gate on, so let HNSW rank directly ----------
    return query
    with ranked as (
      select te.track_id as tid, (te.text_vec <=> q_vec) as d
      from track_embeddings te
      order by te.text_vec <=> q_vec
      limit n * 5
    )
    select t.id, t.title, a.id, a.name, t.album, t.year, t.duration_sec,
           t.audio_url, t.page_url, t.license_short, t.license_url, t.artwork_url, t.tags,
           f.bpm, f.bpm_confidence, f.tonic, f.mode, f.mode_confidence, f.key_name,
           f.baseline_key_name, f.mode_scores, f.hpcp,
           f.energy, f.brightness, f.instrumental_likelihood, f.loudness_db,
           f.spectral_centroid, f.spectral_flatness, f.percussive_ratio,
           a.emergence_percentile, a.listenbrainz_listens,
           (r.d - p_tags_weight * ov.v), ov.v
    from ranked r
    join tracks         t on t.id = r.tid
    join audio_features f on f.track_id = r.tid
    join artists        a on a.id = t.artist_id
    cross join lateral (
      select case when p_tags_boost is null then 0.0
                  when exists (select 1 from unnest(t.tags) g, unnest(p_tags_boost) w
                               where lower(g) like '%'||lower(w)||'%' or lower(w) like '%'||lower(g)||'%')
                  then 1.0 else 0.0 end as v) ov
    where t.analyzed and t.embedded
    order by (r.d - p_tags_weight * ov.v) asc nulls last,
             a.emergence_percentile asc nulls last,
             f.mode_confidence desc nulls last
    limit n;
    return;
  end if;

  -- ---- GATED PATH: hard constraints first, always -------------------------
  return query
  with gate as (
    select t.id as tid
    from tracks t
    join audio_features f on f.track_id = t.id
    join artists       a on a.id        = t.artist_id
    where t.analyzed and t.embedded
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
      and (p_tags_any is null or exists (
             select 1 from unnest(t.tags) g, unnest(p_tags_any) w
             where lower(g) like '%'||lower(w)||'%' or lower(w) like '%'||lower(g)||'%'))
      and (p_exclude        is null or not (t.id = any(p_exclude)))
      and (p_text is null or p_text = '' or
           lower(t.title) like '%'||lower(p_text)||'%' or
           a.name_norm    like '%'||lower(p_text)||'%' or
           exists (select 1 from unnest(t.tags) g where lower(g) like '%'||lower(p_text)||'%'))
  ),
  ranked as (
    select te.track_id as tid,
           coalesce(
             case
               when q_vec is null and p_desc_vec is null then null
               when q_vec is null      then (te.descriptor_vec <=> p_desc_vec)
               when p_desc_vec is null then (te.text_vec       <=> q_vec)
               else (1.0 - p_desc_weight) * (te.text_vec <=> q_vec)
                  +        p_desc_weight  * (te.descriptor_vec <=> p_desc_vec)
             end, 1.0) as d
    from track_embeddings te
    where te.track_id in (select g.tid from gate g)
    order by 2 asc
    limit n * 3
  )
  select t.id, t.title, a.id, a.name, t.album, t.year, t.duration_sec,
         t.audio_url, t.page_url, t.license_short, t.license_url, t.artwork_url, t.tags,
         f.bpm, f.bpm_confidence, f.tonic, f.mode, f.mode_confidence, f.key_name,
         f.baseline_key_name, f.mode_scores, f.hpcp,
         f.energy, f.brightness, f.instrumental_likelihood, f.loudness_db,
         f.spectral_centroid, f.spectral_flatness, f.percussive_ratio,
         a.emergence_percentile, a.listenbrainz_listens,
         (r.d - p_tags_weight * ov.v), ov.v
  from ranked r
  join tracks         t on t.id = r.tid
  join audio_features f on f.track_id = r.tid
  join artists        a on a.id = t.artist_id
  cross join lateral (
    select case when p_tags_boost is null then 0.0
                when exists (select 1 from unnest(t.tags) g, unnest(p_tags_boost) w
                             where lower(g) like '%'||lower(w)||'%' or lower(w) like '%'||lower(g)||'%')
                then 1.0 else 0.0 end as v) ov
  order by (r.d - p_tags_weight * ov.v) asc nulls last,
           a.emergence_percentile asc nulls last,
           f.mode_confidence desc nulls last
  limit n;
end;
$$;
