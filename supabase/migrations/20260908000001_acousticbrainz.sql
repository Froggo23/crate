-- Support a second, much larger corpus source: AcousticBrainz.
--
-- WHY. Downloading MP3s to compute features is the right thing to do only when
-- the features do not already exist. For ~7M recordings they DO exist:
-- AcousticBrainz ran Essentia over user-submitted libraries and published the
-- results, including tonal.hpcp -- the harmonic pitch class profile this
-- project's mode classifier consumes. Reusing that work means no audio transfer
-- at all, real MusicBrainz identities, and Essentia's own key output as a
-- baseline rather than a reimplementation of it.
--
-- WHAT IT COSTS, measured on 1,161 sampled records rather than assumed:
-- AcousticBrainz stores AGGREGATE HPCP (mean/median/var over the track), not
-- per-frame. Re-running key detection on the stored mean reproduces Essentia's
-- own answer only 52% of the time (hpcp.mean + Temperley profile; median and
-- max are worse). So the stored profile carries roughly half the tonal
-- information of the per-frame analysis it came from, and the bass-register,
-- downbeat and phrase-final weighting this project's tonic prior depends on
-- cannot be reconstructed from it at all.
--
-- Hence `hpcp_source`: every row records which pipeline produced it, so the two
-- tiers are never silently mixed in an evaluation.

-- AcousticBrainz rows have no audio to stream; they link out instead.
alter table tracks alter column audio_url drop not null;

alter table tracks add column if not exists mbid uuid;
alter table tracks add column if not exists external_url text;
create index if not exists tracks_mbid on tracks (mbid);

alter table audio_features
  add column if not exists hpcp_source text not null default 'audio',
  add column if not exists chords_histogram double precision[],
  add column if not exists chords_key text,
  add column if not exists chords_scale text,
  add column if not exists key_strength double precision,
  add column if not exists hpcp_entropy double precision;

create index if not exists af_hpcp_source on audio_features (hpcp_source);

comment on column audio_features.hpcp_source is
  'audio = per-frame HPCP computed here from the waveform, with structural '
  'weighting. acousticbrainz = aggregate HPCP from the published dump, no '
  'structural prior available. Never pool these in an evaluation.';
