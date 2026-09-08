# CRATE

**A natural-language search engine for music that understands theory, not just popularity.**

Ask for *"dub techno from emerging artists, around 100 BPM"* or *"uptempo electronica in Phrygian,
no vocals, high energy"* and get back tracks that actually satisfy those constraints — because every
track in the index was decoded and analysed by signal processing, not looked up in a tag database.

---

## Why this exists

Recommendation on streaming platforms runs on collaborative filtering: the system learns from what
large numbers of people listened to together. That works for popular music and fails structurally for
everything else, because a track with fifty listeners has almost no co-listening signal to learn from.
The result is a popularity feedback loop.

There is a second gap. Musicians don't think in mood words. They think in specifics — *"dub techno
around 100 BPM"*, *"Phrygian, no vocals"*, *"the low end of early Basic Channel but brighter on top"*.
No commercial service accepts a query like that. Search boxes match text against titles; filters, where
they exist, cover genre and decade.

CRATE answers those queries, and it does it without ever looking at listening behaviour.

---

## The core contribution: modal, scale-aware key detection

This is the part that makes it a music project rather than a web app.

Standard key detection outputs a tonic and a **binary** mode: major or minor. Essentia, librosa, and
every commercial tool work this way. But a large share of electronic, film and non-Western music is
modal, and **a track in E Phrygian contains exactly the same seven notes as C major and A minor.** A
pitch-class histogram cannot separate them, because by construction all three are identical.

What separates them is *which note is the tonal centre*. So CRATE does not pick a tonic and then a mode.
It searches all **12 tonics × 10 modes** jointly, and scores every hypothesis with four independent
kinds of evidence:

| Evidence | What it measures | Why a standard detector misses it |
|---|---|---|
| **Template fit** | Correlation of the tonic-rotated HPCP against a weighted scale-degree template | This is the *only* thing a standard detector has |
| **Structural tonic prior** | Bass-register energy (< 250 Hz), downbeat occurrence, phrase-final position | Standard detectors weight by duration. A pad holding a C for eight bars under an E-centred bassline wins the duration vote and loses the musical argument |
| **Characteristic-degree contrast** | The one degree distinguishing a mode from its nearest neighbour, against the degree that neighbour has instead | For Phrygian this is the ♭2 above an emphasised tonic — the plan's diagnostic tell, encoded literally |
| **Scale membership** | Mean energy on the mode's degrees vs. off them | The argument a musician makes out loud: *"it isn't Aeolian, there's no F♯ anywhere in the track"* |

The ten modes: Ionian, Dorian, Phrygian, Lydian, Mixolydian, Aeolian, Locrian, harmonic minor,
Phrygian dominant, whole tone.

**When the evidence disagrees, the classifier abstains.** Confidence is the geometric mean of template
fit, margin over the runner-up, and tonal clarity — so any one of them failing collapses it. An honest
*"mode unclear"* is a better result than a confident wrong label, and about half this corpus gets one.

### Measured results

Synthetic benchmark — audio synthesised directly *from* a known tonic and mode, so ground truth is not
in dispute. Reproduce with `npm run test:dsp`.

| Condition | CRATE tonic | K–S tonic | CRATE mode | K–S mode |
|---|---|---|---|---|
| **Clear** — the tonic is also the loudest pitch class | **8/8** | 8/8 | **8/8** | 2/8 |
| **Ambiguous** — harmony dwells on the parent major triad | **8/8** | 5/8 | **6/8** | 2/8 |

The ambiguous condition is the case the project exists for: pitch-class content identical to the parent
major scale, with the modal tonic established *only* by bass register, downbeat placement and
phrase-final resolution. Krumhansl–Schmuckler loses the tonal centre on 3 of 8 by collapsing onto the
relative major.

**Read the baseline row honestly.** Its mode ceiling is 2/8 *by construction* — it has only major and
minor templates and cannot emit "Dorian" at all. That is the structural limitation being demonstrated,
not a scoring trick. Its **tonic** score is the fair head-to-head, and it loses that too.

The baseline is a from-scratch reimplementation of Krumhansl–Schmuckler with the Krumhansl–Kessler
profiles (Temperley's are also included), which is the algorithm family behind Essentia's `KeyExtractor`
and therefore behind most published MIR features. It is reimplemented rather than shelled out to so that
**both systems receive the identical HPCP** — the comparison isolates the classifier, not the front end.

The synthetic benchmark is a *gate*, not the result. The real evaluation needs hand labels; the
`/eval` page contains the labelling tool for building that set, and the table fills in as it grows.

---

## Architecture

```
query ──▶ [1] LLM parser (strict JSON schema, provider-agnostic)
             ├─ hard:   bpm · key · mode · vocals · year · duration
             │          · energy · brightness · emergence ceiling
             ├─ boost:  style tags — reorder only, never exclude
             └─ semantic: "hazy, cavernous, warm tape saturation"
                          └──▶ embedded ──▶ vector(1536)
                    │
          [2] Hybrid retrieval — crate_search()
                    │   SQL filter FIRST, inside a CTE
                    │   then cosine similarity over pgvector, within survivors only
                    │
          [3] LLM re-ranker — top 50 + full feature profiles
                    │   → ordering + one grounded sentence per track
                    │
          [4] Player + thumbs ──▶ relevance_events
```

### Filter first, then rank — and why the order is structural

Hard constraints are applied as SQL predicates inside a CTE **before** any similarity is computed. Only
what survives is scored against the embedded vibe text. If a vocal track could outrank an instrumental
one on a "no vocals" query because it matched the mood better, the constraint was never a constraint.
Here the boundary is a `WITH` clause in one SQL function, so it cannot be crossed.

A useful consequence: because the boundary is explicit, **a query that returns nothing can say exactly
which predicate emptied it.** `crate_constraint_funnel()` reports per-constraint and cumulative survivor
counts, so the UI says *"31 tracks matched your tempo range, 7 of those were Phrygian, none of those 7
were instrumental — relax that one first"*. A system that blends everything into one similarity score
has no such boundary to point at.

### Genre is a preference, not a predicate

Style tags **boost ranking and never exclude**. This was a bug before it was a design decision. Measured
across 20 arbitrary queries, the parser emitted a tag constraint on 15 of them, and tags were the sole
cause of every empty result — because this corpus's tag vocabulary is self-declared and thin
(`electronic` 514, `ambient` 447, `experimental` 422), so intersecting against "lo-fi hip hop" or
"cinematic orchestral" empties the set even though the corpus plainly contains that music.

It is also what the plan actually specifies: the hard constraints are listed as *"bpm range, key, mode,
instrumental, year, emergence ceiling"*. Tags were never among them. Genre belongs on the semantic side,
where it can rank without excluding.

### Progressive relaxation

One over-tight constraint should degrade an answer, not erase it. When fewer than five tracks survive,
constraints are relaxed in order of **how likely they were inferred rather than stated** — a
mode-confidence floor is always the parser's own invention; a named key is the user's:

```
mode-confidence floor → energy/brightness → tempo widened 25% → duration/year
→ artist-title text → obscurity ceiling → tempo dropped → key
```

**Mode, key-as-mode and the vocals requirement are never relaxed.** The plan is explicit that a vocal
track must never appear in a "no vocals" query regardless of how well it matches, and that holds here:
exact matches keep their position, relaxed ones are appended and visibly marked, and every relaxation
step is named in the UI. Silently widening a filter would be worse than returning nothing.

Measured before and after, on the same 20 arbitrary queries:

| | before | after |
|---|---|---|
| Empty results | 4/20 (20%) | **0/20** |
| Fewer than 5 results | 9/20 | **0/20** |
| Filled the candidate pool with no relaxation | — | **19/20** |
| Relevance (≥3 tag matches in top 10) | — | **5/6** |
| Hard-constraint violations | — | **0** |

### Obscurity as an objective, not a penalty

Every conventional recommender treats low popularity as weak evidence and down-ranks it. CRATE inverts
that. Per artist:

```
nl(x)      = ln(1+x) normalised across the corpus
age_factor = min(1, days_since_first_release / 3650)
pop_raw    = (0.55·nl(listens) + 0.20·nl(deezer_fans)
            + 0.15·nl(catalog_size) + 0.10·nl(label_size)) · (0.6 + 0.4·age_factor)
```

`emergence_percentile` is the percentile rank of `pop_raw`, so **low means obscure**. "Emerging only"
sets a ceiling of 20. Recent arrivals have their popularity discounted by up to 40%, which is why a
brand-new artist with moderate listens still reads as emerging. Recomputed nightly by a Vercel cron.

Artists that cannot be resolved keep a null percentile and are treated as **passing** an obscurity
ceiling — an unresolvable artist is almost certainly obscure, and excluding them would defeat the point.

---

## What is measured here vs. looked up

**Everything musical is measured.** Tempo, harmonic pitch class profile, MFCCs, spectral descriptors and
dynamics are computed from decoded PCM by code in this repository — including the FFT. There is no
Essentia, no librosa, no audio-feature API.

| Stage | Implementation |
|---|---|
| Decode | ffmpeg → 60 s mono excerpt at 22.05 kHz, from 25% into the track, fetched by HTTP range |
| STFT | Radix-2 Cooley–Tukey, 8192/2048 for harmony (2.7 Hz bins), 1024/256 for rhythm (11.6 ms hop) |
| HPCP | Gómez (2006) — spectral peak picking, parabolic interpolation, harmonic summation over 8 partials, cos² pitch-class spreading |
| Structural profiles | Global, bass (< 250 Hz), downbeat-weighted, phrase-final |
| Tempo | Log-compressed spectral-flux novelty → autocorrelation tempogram with a log-normal 120 BPM prior → beat and bar grid |
| Timbre | Spectral centroid / rolloff / flatness / bandwidth / flux, ZCR, 13 MFCCs (mean + std) over a 64-band mel spectrogram |
| Percussiveness | Median-filter harmonic/percussive separation (Fitzgerald 2010) on the mel spectrogram |
| Mode | Joint 12 × 10 hypothesis search (above) |
| Baseline | Krumhansl–Schmuckler / Temperley, on the identical profile |

External services are used **only for identity and popularity**, never for anything musical:
MusicBrainz (artist MBIDs), ListenBrainz (open listen counts), Deezer (a second popularity signal),
Internet Archive (the corpus itself).

---

## Honest limitations

These are the things that would be wrong to leave out of a write-up.

**1. Vocal detection is the weakest number in the system.** There is no trained vocal model here.
Instrumental likelihood comes from 3–8 Hz amplitude modulation in the 300–3000 Hz band — the syllabic
rate of singing (Scheirer & Slaney 1997) — combined with mid-band energy ratio and centroid variability.
A snare on the backbeat at 120 BPM lands in the same modulation band. The "no vocals" constraint is only
ever as good as this heuristic, which is to say: usable, not reliable.

**2. The semantic vector is not CLAP.** The plan specifies LAION-CLAP. CLAP needs ~2 GB of weights and a
torch runtime and cannot run in a serverless function — and a retrieval path that only works on a
workstation is not a deployed system. Instead each track is *described in words grounded in its measured
features* (`src/lib/card.ts`) and that description is embedded with `text-embedding-3-small`. It runs
anywhere and every card is stored and inspectable, but it can only express distinctions the vocabulary
encodes; real CLAP captures texture this cannot name. The schema reserves `clap_vec vector(512)` and
`scripts/clap_embed.py` ships ready to fill it — **including the checkpoint sanity test the plan
demands**, which refuses to run on a text tower whose embeddings don't discriminate.

**3. A 60-second excerpt.** Analysis reads one minute from 25% into each track. A piece that changes mode
at the bridge is labelled from its first section. This is a bandwidth trade, and it is stated in the code.

**4. The corpus is uneven.** Net label releases include unfinished sketches, live sets and field
recordings alongside finished records. Some of it is not good. A high abstention rate is partly the
classifier being careful and partly the material genuinely having no tonal centre to find.

**5. Thresholds are provisionally calibrated.** The tonal-clarity window was first set from a synthetic
pure triad (0.28) and was measurably wrong — real mixes carry drums, noise and reverb that spread energy
across all twelve pitch classes, and the corpus distribution is p50 0.043 / p75 0.092. It was recalibrated
against measured audio. The defensible calibration is against hand labels; `scripts/reclassify.ts` exists
so that sweep costs seconds rather than a re-crawl.

**6. Label size is a heuristic.** Without a Discogs token, net-label size is derived from the archive.org
identifier stub (`hc040`, `hc041` → `hc`). It is a real signal, but it is a proxy.

---

## The corpus — two tiers, deliberately

CRATE indexes from two sources with **very different amounts of information**, and every row records
which one it came from (`audio_features.hpcp_source`). They are never pooled in an evaluation.

### Tier 1 — AcousticBrainz (breadth, no audio transferred)

[AcousticBrainz](https://acousticbrainz.org/download) ran Essentia across user-submitted libraries and
published the results before shutting down in 2022: 29.4M submissions, ~7M unique recordings. Crucially
it publishes `tonal.hpcp` — the harmonic pitch class profile this project's classifier consumes.

**Downloading audio to compute features is only correct when the features do not already exist.** For
these recordings they do, so CRATE reuses them: one bounded download, no audio transfer, and no
rehosting. What that buys:

- **MusicBrainz IDs on every row**, so artist identity and ListenBrainz listen counts resolve exactly
  instead of by fuzzy name match
- **Essentia's own key output as the baseline** — the real extractor named in §6 of the plan, not a
  reimplementation of it
- **`voice_instrumental`, a trained classifier**, replacing the 3–8 Hz modulation heuristic that was
  the weakest number in the system
- **Four independent genre taxonomies**, which §4.2 explicitly asks for

**What it costs, measured rather than assumed.** AcousticBrainz stores *aggregate* HPCP (mean/median/var
over the whole track), never per-frame. Re-running key detection on the stored mean reproduces
Essentia's *own* answer only **52%** of the time (`hpcp.mean` + Temperley; median and max are worse). So
roughly half the tonal information is gone before the classifier starts, and the bass-register,
downbeat and phrase-final weighting cannot be reconstructed from an aggregate at all.

**A negative result worth recording.** The obvious substitute for the lost structural prior was
`chords_histogram` — which chord roots the harmony dwells on. It was measured on 1,908 records and it
makes things **worse**: major/minor family agreement with Essentia was 70.1% using no chord evidence,
55.0% using it for tonic-chord quality, and 53.1% using it as the tonic prior. The most-played chord is
too often the dominant or subdominant. The histogram is still stored; it is not fed to the classifier.

Because the aggregate profile is flatter than a per-frame one (p50 tonal clarity 0.027 vs 0.043), this
tier gets its own calibrated clarity window — see `npm run calibrate:ab`, which reproduces the sweep.

Bin alignment for the 36-bin profile is undocumented upstream, so it was **measured**: folding at each
of 12 offsets and scoring how often Krumhansl–Schmuckler reproduces Essentia's reported key gives a
sharp winner at offset 3 (**bin 0 = pitch class A**), agreeing with Essentia's 440 Hz reference. Offset
10 scores nearly as high because it is a perfect fifth away and the dominant is frequently the loudest
chroma bin — the exact trap an argmax-based calibration falls into.

These rows carry **no streamable audio** and link out to MusicBrainz. Nothing is rehosted.

### Tier 2 — Internet Archive netlabels (depth, playable)

Creative Commons releases from the Internet Archive's [`netlabels`](https://archive.org/details/netlabels)
collection — 77,000 audio items of independent, mostly electronic music.

This is a deliberate substitution for the plan's MTG-Jamendo. MTG-Jamendo's audio is a 46 GB download for
the mood subset alone; the netlabels collection streams per-track over HTTP range requests, so the corpus
builds incrementally and resumes after a failure. More importantly it is the **same population** — exactly
the independent, low-listener-count music the obscurity ranking is built to surface — and the licences
permit hosting a playable demo, which the plan is explicit about: *a recommender you cannot play is not a
demo.*

These are the **only** tracks with full per-frame structural analysis and playable audio, which makes
them the control condition for measuring what that analysis is worth.

Snapshot at time of writing (the `/corpus` page is live):

| | |
|---|---|
| Tracks analysed | 558 |
| Tracks searchable (analysed + embedded) | 452 |
| Artists | 197 |
| Mode assigned | 48% — the rest abstain rather than guess |
| Modes found | Phrygian 61 · Ionian 49 · Aeolian 36 · Dorian 34 · harmonic minor 26 · Lydian 21 · Mixolydian 14 · Phrygian dominant 14 · Locrian 7 · whole tone 6 |

Ingestion is resumable and continues to 2,500+ with `npm run ingest`.

---

## Stack

- **Next.js 16** (App Router) on Vercel
- **Supabase Postgres + pgvector**, HNSW indexes, RLS deny-all with server-side service-role access
- **Retrieval and diagnostics in SQL** — `crate_search()`, `crate_constraint_funnel()`,
  `refresh_emergence()`, `bump_rate_limit()`
- **Provider-agnostic LLM layer** — Anthropic (`claude-opus-5`, structured outputs via
  `output_config.format`) and OpenAI (`response_format: json_schema`, `strict: true`) adapters behind one
  interface, selected by environment. Both constrain generation to the schema rather than asking for JSON.
- **Rule-based fallback parser** — the app stays usable with no LLM key at all, and it doubles as the
  keyword-search control condition in evaluation
- **Client-side DSP** — the `/analyze` page runs the entire signal chain in the browser via Web Audio,
  because Vercel has no ffmpeg and bundling a 78 MB static build into every function is the wrong trade

---

## Pages

| Route | What it does |
|---|---|
| `/` | Search. Shows the parsed constraints, the semantic intent, per-stage timings, and why any empty result was empty |
| `/analyze` | Runs the full pipeline in your browser on any CORS-enabled URL or local file. HPCP wheel, ranked hypotheses with the score decomposed into its four terms, chromagram, every descriptor |
| `/eval` | The benchmark table, per-mode precision/recall against hand labels, and the labelling tool that builds them |
| `/corpus` | Mode distribution, tempo histogram, tag frequencies, honest caveats |
| `/about` | How it works and what is weak about it |

---

## Running it

```bash
npm install
cp .env.example .env.local     # then fill in the values
npm run db:push                # apply migrations to Supabase
npm run ingest -- --target 500 # build a corpus (resumable)
npm run enrich                 # artist identity + popularity + emergence
npm run dev
```

Tests:

```bash
npm run test:dsp               # DSP correctness + the modal benchmark
npm run test:parser            # 25-case parser regression set
npm run test:parser -- --fallback   # the same set against the rule-based control
npm run bench                  # regenerate data/benchmark.json
```

Iterating on the classifier without re-downloading audio:

```bash
npm run reclassify -- --dry    # what would change
npm run reclassify             # apply
```

All four structural HPCP variants are persisted, so tuning the classifier is a database query rather than
an hours-long re-crawl. This is the difference between iterating on Phase 1 and not iterating on it.

### Environment

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | Supabase **transaction** pooler (`:6543`) — serverless |
| `DIRECT_URL` | yes | Supabase **session** pooler (`:5432`) — scripts and migrations |
| `OPENAI_API_KEY` | for embeddings | `text-embedding-3-small`, 1536-dim |
| `ANTHROPIC_API_KEY` | optional | Present ⇒ Claude is used for parsing and re-ranking |
| `LLM_PROVIDER` | optional | `anthropic` \| `openai`; auto-detects otherwise |
| `CRON_SECRET` | optional | Vercel sends it as a bearer token to the emergence cron |
| `CRATE_USER_AGENT` | recommended | MusicBrainz requires a contactable UA |

Without any LLM key the app still runs: the rule-based parser takes over and re-ranking is skipped.

---

## Repository map

```
src/lib/dsp/       the entire signal chain, no external DSP libraries
  fft.ts           radix-2 FFT, STFT, Pearson correlation
  hpcp.ts          harmonic pitch class profile + the three structural variants
  tempo.ts         onset novelty, tempogram, beat and bar grid
  spectral.ts      mel filterbank, MFCC, HPSS, descriptors, syllabic modulation
  modes.ts         mode templates and the joint tonic × mode classifier   ← the contribution
  baseline.ts      Krumhansl-Schmuckler, the control condition
  core.ts          browser-safe orchestrator (analyzePcm)
  analyze.ts       Node-only URL entry point
  decode.ts        ffmpeg
  browser.ts       Web Audio decoding for the /analyze page
src/lib/llm/       schema, prompts, both provider adapters, parser, re-ranker
src/lib/sources/   archive.org corpus, MusicBrainz / ListenBrainz / Deezer
src/lib/search.ts  parse → filter → vector → re-rank → log
src/lib/eval.ts    per-mode precision/recall against hand labels
supabase/migrations/
scripts/           ingest, enrich, reclassify, tests, clap_embed.py
```

---

## Licence and attribution

Code is MIT. Audio is **not** — every track is streamed directly from the Internet Archive under the
Creative Commons licence its release carries, and every result links to its source page and licence.
Nothing is rehosted.
