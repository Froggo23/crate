export const metadata = { title: 'How CRATE works' };

function H({ children }: { children: React.ReactNode }) {
  return <h2 className="text-[16px] font-medium mt-8 mb-2 text-ink">{children}</h2>;
}
function P({ children }: { children: React.ReactNode }) {
  return <p className="text-[13.5px] text-dim leading-[1.75] mb-3">{children}</p>;
}
function Code({ children }: { children: React.ReactNode }) {
  return <code className="text-accent text-[12.5px]">{children}</code>;
}

export default function AboutPage() {
  return (
    <div className="mx-auto max-w-2xl px-5 py-10">
      <h1 className="text-[24px] font-semibold tracking-tight">How CRATE works</h1>
      <P>
        Recommendation on streaming platforms runs on collaborative filtering: the system learns from what large
        numbers of people listened to together. That works for popular music and fails structurally for
        everything else, because a track with fifty listeners has almost no co-listening signal to learn from.
        CRATE does not look at listening behaviour at all. It listens to the audio.
      </P>

      <H>The part that is actually hard</H>
      <P>
        Standard key detection outputs a tonic and a binary mode: major or minor. Essentia, librosa, and every
        commercial tool work this way. But a large share of electronic, film and non-Western music is modal, and
        a track in E Phrygian contains exactly the same seven notes as C major and A minor. A pitch-class
        histogram cannot separate them, because by construction all three are identical.
      </P>
      <P>
        What separates them is which note is the <em>tonal centre</em>. So CRATE does not pick a tonic and then a
        mode — it searches all 12×10 hypotheses jointly and scores each with four independent kinds of evidence:
      </P>
      <ul className="text-[13px] text-dim leading-[1.7] space-y-1.5 mb-3 list-disc pl-5">
        <li><strong className="text-ink">Template fit</strong> — correlation of the tonic-rotated HPCP against a weighted scale-degree template.</li>
        <li><strong className="text-ink">Structural tonic prior</strong> — emphasis, not duration: bass-register energy below 250 Hz, downbeat occurrence, and phrase-final position. A pad holding a C for eight bars under an E-centred bassline should not win the tonic vote, and under duration weighting it does.</li>
        <li><strong className="text-ink">Characteristic-degree contrast</strong> — the one degree that distinguishes a mode from its nearest neighbour, against the degree that neighbour has instead. For Phrygian this is the flat second above an emphasised tonic.</li>
        <li><strong className="text-ink">Scale membership</strong> — mean energy on the mode&apos;s degrees versus off them. This is the argument a musician makes out loud: &ldquo;it isn&apos;t Aeolian, there&apos;s no F♯ anywhere in the track.&rdquo;</li>
      </ul>
      <P>
        When those disagree, or when nothing fits, the classifier <strong className="text-ink">abstains</strong>.
        An honest &ldquo;mode unclear&rdquo; is a better result than a confident wrong label, and roughly half
        this corpus gets one. Confidence is the geometric mean of template fit, margin over the runner-up, and
        tonal clarity — so any single one of them failing collapses it.
      </P>

      <H>Filter first, then rank</H>
      <P>
        Retrieval is deliberately ordered. An LLM parses your sentence into a strict JSON object, splitting what
        is measurable (tempo, key, mode, vocals, obscurity) from what is a vibe (&ldquo;cavernous&rdquo;,
        &ldquo;warm tape saturation&rdquo;). The measurable half becomes SQL predicates. Only what survives that
        filter is scored against the embedded vibe text, and only then does a second model reorder the survivors
        and write a reason for each.
      </P>
      <P>
        This ordering is the single most important decision in the system. If a vocal track can outrank an
        instrumental one on a &ldquo;no vocals&rdquo; query because it matched the mood better, the constraint
        was never a constraint. Here the boundary is a <Code>WITH</Code> clause in one SQL function, so it cannot
        be crossed — and because the boundary is explicit, a query that returns nothing can report exactly which
        predicate emptied it.
      </P>

      <H>Obscurity is the objective, not a penalty</H>
      <P>
        Every conventional recommender treats low popularity as weak evidence and down-ranks it. CRATE inverts
        that. An emergence score is built per artist from listen counts, catalogue size, label size and time
        since first release, and exposed as a ceiling you control. &ldquo;Emerging only&rdquo; means no artist
        above the 20th popularity percentile.
      </P>

      <H>What is honestly weak</H>
      <ul className="text-[13px] text-dim leading-[1.7] space-y-2 mb-3 list-disc pl-5">
        <li>
          <strong className="text-ink">Vocal detection.</strong> There is no trained vocal model here. Instrumental
          likelihood comes from 3–8&nbsp;Hz amplitude modulation in the 300–3000&nbsp;Hz band — the syllabic rate
          of singing — and a snare on the backbeat lands in the same place. It is the weakest number in the
          system, and the &ldquo;no vocals&rdquo; constraint is only ever as good as it is.
        </li>
        <li>
          <strong className="text-ink">The semantic vector is not CLAP.</strong> The plan calls for a joint
          text-audio embedding. CLAP needs ~2&nbsp;GB of weights and a torch runtime and cannot run in a
          serverless function. Instead each track is <em>described in words grounded in its measured features</em>,
          and that description is embedded. It runs anywhere and every card is inspectable — but it can only
          express distinctions the vocabulary encodes. The schema reserves a <Code>clap_vec</Code> column and the
          repository ships the offline script to fill it.
        </li>
        <li>
          <strong className="text-ink">A 60-second excerpt.</strong> Analysis reads one minute from 25% into each
          track. A piece that changes mode at the bridge is labelled from its first section.
        </li>
        <li>
          <strong className="text-ink">The corpus is uneven.</strong> Net label releases include sketches, live
          sets and field recordings. Some of it is not good, and a licensed catalogue would change what this
          system feels like to use.
        </li>
      </ul>

      <H>Everything is measured here</H>
      <P>
        No feature in this system comes from an external metadata service. Tempo, harmonic pitch class profile,
        MFCCs, spectral descriptors and dynamics are all computed from decoded PCM by code in this repository —
        including the FFT. MusicBrainz, ListenBrainz and Deezer are used only for artist identity and popularity,
        never for anything musical.
      </P>
      <p className="text-[12px] text-mute mt-8 leading-relaxed">
        Audio is streamed directly from the Internet Archive under the Creative Commons licence each release
        carries; every result links to its source page and licence. Source, including the full DSP chain and the
        evaluation harness, is on{' '}
        <a href="https://github.com/Froggo23/crate" target="_blank" rel="noreferrer noopener"
           className="text-dim hover:text-accent underline underline-offset-2">GitHub</a>.
      </p>
    </div>
  );
}
