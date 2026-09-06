-- Genre tags become a RANKING SIGNAL, not a hard filter.
--
-- Measured failure: across 20 arbitrary queries, the parser emitted a tag
-- constraint on 15 of them and tags were the sole cause of every empty result.
-- The reason is that this corpus's tag vocabulary is self-declared and thin --
-- "electronic" (514), "ambient" (447), "experimental" (422) -- so an intersection
-- against a phrase like "lo-fi hip hop" or "cinematic orchestral" empties the set
-- even though the corpus plainly contains that music.
--
-- This is also what the project plan actually specifies. Section 3 lists the hard
-- constraints as "bpm range, key, mode, instrumental, year, emergence ceiling".
-- Tags are not among them, and genre was always meant to live on the semantic
-- side. Treating a self-declared label as an inviolable predicate was the bug.
--
-- p_tags_any is KEPT for the case where a caller genuinely wants a hard tag
-- filter; the application no longer populates it by default.

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
  distance                double precision,
  tag_overlap             double precision
)
language sql
stable
as $$
  with filtered as (
    -- ==== HARD CONSTRAINT GATE =============================================
    -- Nothing below this line can promote a track that failed here.
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
      and (p_tags_any is null or exists (
             select 1
             from unnest(t.tags) g, unnest(p_tags_any) w
             where lower(g) like '%' || lower(w) || '%'
                or lower(w) like '%' || lower(g) || '%'))
      and (p_exclude        is null or not (t.id = any(p_exclude)))
      and (p_text is null or p_text = '' or
           lower(t.title) like '%' || lower(p_text) || '%' or
           a.name_norm    like '%' || lower(p_text) || '%' or
           exists (select 1 from unnest(t.tags) g where lower(g) like '%' || lower(p_text) || '%'))
  ),
  scored as (
    select
      t.id as tid,
      case
        when q_vec is null and p_desc_vec is null then null
        when q_vec is null      then (te.descriptor_vec <=> p_desc_vec)
        when p_desc_vec is null then (te.text_vec       <=> q_vec)
        else (1.0 - p_desc_weight) * (te.text_vec       <=> q_vec)
           +        p_desc_weight  * (te.descriptor_vec <=> p_desc_vec)
      end as raw_distance,
      -- fraction of the requested style tags this track carries
      case when p_tags_boost is null or array_length(p_tags_boost, 1) is null then 0.0
      else least(1.0, (
        select count(distinct w)::double precision
        from unnest(t.tags) g, unnest(p_tags_boost) w
        where lower(g) like '%' || lower(w) || '%'
           or lower(w) like '%' || lower(g) || '%'
      ) / array_length(p_tags_boost, 1)) end as overlap
    from filtered
    join tracks           t  on t.id = filtered.tid
    join track_embeddings te on te.track_id = t.id
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
    -- a matching style tag pulls a track forward without ever letting a
    -- non-matching one through the gate above
    (coalesce(s.raw_distance, 1.0) - p_tags_weight * s.overlap) as distance,
    s.overlap as tag_overlap
  from scored s
  join tracks         t on t.id = s.tid
  join audio_features f on f.track_id = t.id
  join artists        a on a.id = t.artist_id
  order by
    case when s.raw_distance is null and s.overlap = 0 then 1 else 0 end,
    (coalesce(s.raw_distance, 1.0) - p_tags_weight * s.overlap) asc,
    a.emergence_percentile asc nulls last,
    f.mode_confidence desc nulls last
  limit greatest(1, least(p_limit, 200));
$$;
