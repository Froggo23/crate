-- Constraint funnel: when a query returns nothing, say WHY.
--
-- "0 results" is the least useful thing a search engine can say. Because CRATE
-- applies constraints as explicit SQL predicates rather than folding them into a
-- similarity score, it can report exactly which one emptied the set: "31 tracks
-- matched your tempo range, 7 of those were Phrygian, and none of those 7 were
-- instrumental." That is only possible in a filter-first design -- a system that
-- ranks by blended similarity has no such boundary to point at.
--
-- Returns both per-constraint survivor counts (each in isolation) and the
-- cumulative funnel, so the UI can name the single constraint to relax.

create or replace function crate_constraint_funnel(
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
  p_min_mode_conf   double precision default null
)
returns jsonb
language sql
stable
as $$
  with flags as (
    select
      (p_bpm_min is null or f.bpm >= p_bpm_min)
        and (p_bpm_max is null or f.bpm <= p_bpm_max)                       as c_bpm,
      (p_tonics is null or f.tonic = any(p_tonics))                         as c_key,
      (p_modes is null or f.mode = any(p_modes))
        and (p_min_mode_conf is null or f.mode_confidence >= p_min_mode_conf) as c_mode,
      (p_instrumental is null
        or (p_instrumental and f.instrumental_likelihood >= 0.60)
        or (not p_instrumental and f.instrumental_likelihood <= 0.45))      as c_vocal,
      (p_energy_min is null or f.energy >= p_energy_min)
        and (p_energy_max is null or f.energy <= p_energy_max)              as c_energy,
      (p_brightness_min is null or f.brightness >= p_brightness_min)
        and (p_brightness_max is null or f.brightness <= p_brightness_max)  as c_bright,
      (p_year_min is null or t.year >= p_year_min)
        and (p_year_max is null or t.year <= p_year_max)                    as c_year,
      (p_duration_min is null or t.duration_sec >= p_duration_min)
        and (p_duration_max is null or t.duration_sec <= p_duration_max)    as c_duration,
      (p_tags_any is null or exists (
         select 1 from unnest(t.tags) g, unnest(p_tags_any) w
         where lower(g) like '%' || lower(w) || '%'
            or lower(w) like '%' || lower(g) || '%'))                       as c_tags,
      (p_text is null or p_text = '' or
         lower(t.title) like '%' || lower(p_text) || '%' or
         a.name_norm    like '%' || lower(p_text) || '%')                   as c_text,
      (p_emergence_max is null or a.emergence_percentile is null
         or a.emergence_percentile <= p_emergence_max)                      as c_emergence
    from tracks t
    join audio_features f on f.track_id = t.id
    join artists       a on a.id = t.artist_id
    where t.analyzed and t.embedded
  )
  select jsonb_build_object(
    'corpus',      count(*),
    'alone',       jsonb_build_object(
      'tempo',      count(*) filter (where c_bpm),
      'key',        count(*) filter (where c_key),
      'mode',       count(*) filter (where c_mode),
      'vocals',     count(*) filter (where c_vocal),
      'energy',     count(*) filter (where c_energy),
      'brightness', count(*) filter (where c_bright),
      'year',       count(*) filter (where c_year),
      'duration',   count(*) filter (where c_duration),
      'tags',       count(*) filter (where c_tags),
      'text',       count(*) filter (where c_text),
      'obscurity',  count(*) filter (where c_emergence)
    ),
    'cumulative',  jsonb_build_object(
      'tempo',      count(*) filter (where c_bpm),
      'key',        count(*) filter (where c_bpm and c_key),
      'mode',       count(*) filter (where c_bpm and c_key and c_mode),
      'vocals',     count(*) filter (where c_bpm and c_key and c_mode and c_vocal),
      'energy',     count(*) filter (where c_bpm and c_key and c_mode and c_vocal and c_energy),
      'brightness', count(*) filter (where c_bpm and c_key and c_mode and c_vocal and c_energy and c_bright),
      'year',       count(*) filter (where c_bpm and c_key and c_mode and c_vocal and c_energy and c_bright and c_year),
      'duration',   count(*) filter (where c_bpm and c_key and c_mode and c_vocal and c_energy and c_bright and c_year and c_duration),
      'tags',       count(*) filter (where c_bpm and c_key and c_mode and c_vocal and c_energy and c_bright and c_year and c_duration and c_tags),
      'text',       count(*) filter (where c_bpm and c_key and c_mode and c_vocal and c_energy and c_bright and c_year and c_duration and c_tags and c_text),
      'obscurity',  count(*) filter (where c_bpm and c_key and c_mode and c_vocal and c_energy and c_bright and c_year and c_duration and c_tags and c_text and c_emergence)
    ),
    'active',      jsonb_build_object(
      'tempo',      (p_bpm_min is not null or p_bpm_max is not null),
      'key',        (p_tonics is not null),
      'mode',       (p_modes is not null or p_min_mode_conf is not null),
      'vocals',     (p_instrumental is not null),
      'energy',     (p_energy_min is not null or p_energy_max is not null),
      'brightness', (p_brightness_min is not null or p_brightness_max is not null),
      'year',       (p_year_min is not null or p_year_max is not null),
      'duration',   (p_duration_min is not null or p_duration_max is not null),
      'tags',       (p_tags_any is not null),
      'text',       (p_text is not null and p_text <> ''),
      'obscurity',  (p_emergence_max is not null)
    )
  )
  from flags;
$$;
