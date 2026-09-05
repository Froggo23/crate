-- Relax tag matching.
--
-- Exact array overlap was too strict to be useful: a user asking for "dub techno"
-- got nothing, because release tags in the wild read "dub-techno", "dubtechno",
-- "techno / dub", or bury the phrase inside a longer string. Substring matching in
-- BOTH directions ("ambient" matches the tag "dark ambient orchestral", and the
-- tag "techno" matches a query for "dub techno") is the behaviour a person expects
-- from a genre filter. It stays a HARD constraint -- only the comparison loosened.

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

-- Backfill brightness for rows analysed before the recalibration (analyzer 1.0.0).
-- The stored spectral centroid is the ground truth, so this is a pure recompute,
-- not a re-analysis.
update audio_features
   set brightness = greatest(0, least(1,
         (ln(greatest(80, spectral_centroid)) - ln(150)) / (ln(5000) - ln(150)))),
       analyzer_version = 'crate-dsp/1.1.0'
 where spectral_centroid is not null
   and (analyzer_version is null or analyzer_version = 'crate-dsp/1.0.0');
