-- Drop the stale 22-argument crate_search overload.
--
-- The tag-boost migration added two parameters. `create or replace function`
-- only replaces when the signature matches EXACTLY, so changing the argument
-- list created a SECOND function rather than replacing the first. Postgres then
-- had two candidates, and any call that did not mention one of the new
-- parameters failed to resolve:
--
--   ERROR 42725: function crate_search(q_vec => vector, p_emergence_max =>
--   unknown, p_limit => unknown) is not unique
--
-- The application always passes p_tags_boost so it resolved unambiguously and
-- kept working, which is exactly what made this dangerous: a latent breakage
-- sitting behind every other caller. Found by a deterministic SQL-level test,
-- not by the app.
--
-- Dropped by explicit argument list so this can never remove the current one.
drop function if exists crate_search(
  vector, vector, double precision,
  double precision, double precision,
  int[], text[],
  int, int,
  boolean, double precision,
  double precision, double precision,
  double precision, double precision,
  double precision, double precision,
  text[], text, double precision,
  uuid[], int
);
