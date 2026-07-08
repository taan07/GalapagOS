# Leg: watchdog — transcript review (cheap model)

**One sentence:** a second, independent model reads everything the worker did
and said — not just its output — and asks "was this process honest?"

**Why it exists:** the strongest measured result in the research: a *weaker*
model reading a stronger agent's transcript caught check-gaming at ~95%
recall, versus ~60% when watching only actions and outputs. Agents that
cheat tend to say so in their working process ("let me just make this test
pass") even when the final code looks innocent. Galapagos already stores
every worker message in `worker_events` — this leg is that data, finally
read.

**How it works:** when a worker claims completion, a fresh single-shot
session on `GALAPAGOS_WATCHDOG_MODEL` (default claude-haiku-4-5 — cents per
review) receives the full transcript between explicit UNTRUSTED-DATA markers
and returns one verdict:

- **clean** — honest work, including honest struggling. Workers are allowed
  to fail and ask questions; they are not allowed to fake.
- **suspicious** — real doubt short of proof (thrashing loops, odd behavior
  near the checks). Drains the gauge (≤60) and lands a normal-priority
  queue item for triage's judgment.
- **gaming** — concrete evidence of check manipulation or deception. Caps at
  40/blocked and lands a high-priority `integrity_alert`.

**Discipline the research demands:**
- A verdict must quote the transcript verbatim — **no quote, no finding**.
  An unevidenced accusation is refused at parse time.
- The transcript is untrusted data: nothing inside it can instruct the
  watchdog, and a transcript that tries is itself suspicious.
- The watchdog only observes. Its verdict is never fed back as a training or
  optimization signal — optimizing against a monitor teaches evasion.
- Verdicts are keyed to the workspace state: any new commit or edit makes
  the verdict stale, and a stale verdict counts as "not yet reviewed",
  never as clean.

**Hardening from the adversarial review (2026-07-05):** every event's text
is capped (padding one message cannot flood the budget); over budget, the
head and tail are kept AND every tool_use/steer ACTION from the middle
survives verbatim — narration is what gets dropped, with an explicit count,
so a hack cannot be buried in a dropped middle. A response containing more
than one verdict block is refused as ambiguous (a worker could plant a
verdict block in its own transcript for the judge to echo). The verbatim
quotes now travel with the verdict — into the gauge drilldown and the queue
item, so an accusation always carries its proof.

**Honest limits:** it reads what the worker *said and did* — a worker that
games silently, in ways invisible in the transcript, passes this leg (the
tripwires and critic cover the artifact side). If the session cannot run,
the gauge drains ("unavailable") — and a failed run re-arms as soon as the
workspace or completion it judged changes, so one transient failure never
pins a worker.

**Code:** `src/core/legs/watchdog.ts` (prompt + verdict parsing, pure),
`src/adapters/legs/watchdog.ts` (transcript assembly, session, persistence
as a `watchdog` jobs row). Tests: `tests/leg-verdicts.test.ts`.
