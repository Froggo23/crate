#!/usr/bin/env python3
"""
Offline LAION-CLAP enrichment — the migration path out of the text-card surrogate.

WHY THIS IS A SEPARATE SCRIPT AND NOT PART OF THE APP
-----------------------------------------------------
The project plan specifies LAION-CLAP for a joint text-audio embedding. CLAP needs
~2 GB of weights plus a torch runtime, which cannot run inside a Vercel function.
The deployed system therefore embeds a generated natural-language description of
each track's measured features instead (see src/lib/card.ts), which runs anywhere
and is fully inspectable but can only express distinctions its vocabulary encodes.

The database reserves `track_embeddings.clap_vec vector(512)` for the real thing.
Run this on any machine with a GPU and the column fills in; nothing else changes.

CHECKPOINT VERIFICATION (plan section 4.3 and action 3)
-------------------------------------------------------
The plan is explicit that `laion/larger_clap_music` has a reported defect where the
text tower returns near-identical embeddings for unrelated inputs, scoring below a
random baseline on retrieval. So this script REFUSES TO RUN until the checkpoint
passes a sanity test: embed four unrelated phrases and confirm their pairwise
cosine similarities actually differ. A silently broken text tower would poison the
whole index while looking like it worked, which is the worst possible failure mode.

USAGE
-----
    pip install torch transformers librosa soundfile psycopg[binary] numpy
    python scripts/clap_embed.py --verify-only
    python scripts/clap_embed.py --limit 500
"""

from __future__ import annotations

import argparse
import os
import sys
import subprocess
import tempfile
from itertools import combinations

import numpy as np

DEFAULT_CHECKPOINT = "laion/clap-htsat-unfused"
BANNED = {"laion/larger_clap_music"}
SAMPLE_RATE = 48_000          # CLAP's expected input rate
EXCERPT_SECONDS = 60
EXCERPT_START_FRACTION = 0.25


def load_env(path: str = ".env.local") -> None:
    if not os.path.exists(path):
        return
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k, v.strip().strip('"').strip("'"))


def cosine(a: np.ndarray, b: np.ndarray) -> float:
    return float(a @ b / ((np.linalg.norm(a) * np.linalg.norm(b)) + 1e-12))


def verify_checkpoint(model, processor) -> bool:
    """Four unrelated phrases must NOT collapse to near-identical vectors."""
    import torch

    phrases = [
        "a dog barking in an empty warehouse",
        "solo acoustic guitar fingerpicking in a quiet room",
        "aggressive distorted industrial techno with a pounding kick",
        "a string quartet playing a slow melancholy adagio",
    ]
    with torch.no_grad():
        inputs = processor(text=phrases, return_tensors="pt", padding=True)
        vecs = model.get_text_features(**inputs).cpu().numpy()

    sims = [(i, j, cosine(vecs[i], vecs[j])) for i, j in combinations(range(len(phrases)), 2)]
    print("\npairwise cosine similarity between four unrelated phrases:")
    for i, j, s in sims:
        print(f"  [{i}] x [{j}]  {s:+.4f}")

    values = [s for _, _, s in sims]
    spread = max(values) - min(values)
    mean_sim = float(np.mean(values))
    print(f"\n  spread {spread:.4f}   mean {mean_sim:.4f}")

    if spread < 0.05:
        print("\nFAIL: the text tower returns near-identical embeddings for unrelated text.")
        print("      This is the documented defect. Do NOT build an index on this checkpoint.")
        return False
    if mean_sim > 0.95:
        print("\nFAIL: every pair is near-identical; the text tower is collapsed.")
        return False
    print("\nPASS: the text tower discriminates between unrelated inputs.")
    return True


def decode_excerpt(url: str, duration: float | None) -> np.ndarray:
    """Same excerpt policy as the TypeScript pipeline: 60 s from 25% in."""
    offset = 0.0
    if duration and duration > EXCERPT_SECONDS * 1.5:
        offset = min(duration * EXCERPT_START_FRACTION, max(0.0, duration - EXCERPT_SECONDS - 5))

    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
        path = tmp.name
    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if offset > 0:
        cmd += ["-ss", f"{offset:.2f}"]
    cmd += ["-i", url, "-t", str(EXCERPT_SECONDS), "-ac", "1", "-ar", str(SAMPLE_RATE), path]
    subprocess.run(cmd, check=True, timeout=180)

    import soundfile as sf
    audio, sr = sf.read(path, dtype="float32")
    os.unlink(path)
    if sr != SAMPLE_RATE:
        import librosa
        audio = librosa.resample(audio, orig_sr=sr, target_sr=SAMPLE_RATE)
    return audio


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", default=DEFAULT_CHECKPOINT)
    ap.add_argument("--limit", type=int, default=200)
    ap.add_argument("--verify-only", action="store_true")
    args = ap.parse_args()

    if args.checkpoint in BANNED:
        print(f"refusing to use {args.checkpoint}: known-defective text tower (see plan section 4.3)")
        return 2

    import torch
    from transformers import ClapModel, ClapProcessor

    print(f"loading {args.checkpoint} …")
    model = ClapModel.from_pretrained(args.checkpoint).eval()
    processor = ClapProcessor.from_pretrained(args.checkpoint)

    if not verify_checkpoint(model, processor):
        return 1
    if args.verify_only:
        return 0

    load_env()
    dsn = os.environ.get("DIRECT_URL") or os.environ.get("DATABASE_URL")
    if not dsn:
        print("DIRECT_URL / DATABASE_URL not set")
        return 2

    import psycopg

    with psycopg.connect(dsn) as conn:
        rows = conn.execute(
            """
            select t.id, t.audio_url, t.duration_sec, t.title
            from tracks t
            join track_embeddings te on te.track_id = t.id
            where t.analyzed and te.clap_vec is null
            limit %s
            """,
            (args.limit,),
        ).fetchall()
        print(f"\n{len(rows)} tracks need a CLAP vector")

        done = failed = 0
        for tid, url, dur, title in rows:
            try:
                audio = decode_excerpt(url, dur)
                with torch.no_grad():
                    inputs = processor(audios=audio, sampling_rate=SAMPLE_RATE, return_tensors="pt")
                    vec = model.get_audio_features(**inputs).cpu().numpy()[0]
                vec = vec / (np.linalg.norm(vec) + 1e-12)
                if vec.shape[0] != 512:
                    raise ValueError(f"expected a 512-dim vector, got {vec.shape[0]}")
                conn.execute(
                    "update track_embeddings set clap_vec = %s, updated_at = now() where track_id = %s",
                    ("[" + ",".join(f"{x:.6f}" for x in vec) + "]", tid),
                )
                conn.commit()
                done += 1
                print(f"  [{done:4}] {str(title)[:52]}")
            except Exception as exc:  # noqa: BLE001 - one bad file must not stop the run
                failed += 1
                print(f"  [fail] {str(title)[:44]}: {exc}")

        print(f"\nembedded {done}, failed {failed}")
    print(
        "\nNext: add a clap_vec branch to crate_search alongside text_vec, and A/B the two\n"
        "retrieval paths on the same queries. That comparison is itself a result worth reporting."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
