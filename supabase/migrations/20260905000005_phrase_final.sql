-- Store the phrase-final HPCP variant alongside the others.
--
-- With all four structural profiles persisted, the mode classifier can be re-run
-- over the entire corpus straight from the database -- no re-downloading, no
-- re-decoding, no re-FFT. That turns the Phase 1 tuning loop (adjust weights ->
-- re-score against the hand-labelled set) from an hours-long re-crawl into a
-- seconds-long query, which is the difference between iterating on the
-- classifier and not iterating on it.
alter table audio_features add column if not exists hpcp_phrase_final double precision[];
