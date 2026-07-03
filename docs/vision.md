# Galapagos Vision

Galapagos is a local-first driver for AI agent orchestration. One person runs a
team of AI coding workers; Galapagos exists so that person operates at the
**direction level** — deciding what the product should be and how it should
feel — while the system absorbs everything below that altitude: keeping workers
on-vision, catching staleness and drift, verifying claims against evidence, and
turning finished work into something a human can absorb in seconds.

## The user's altitude

The user makes high-level decisions. They should never be pulled into
micro-level bugs, agent babysitting, or combing transcripts. Two rules follow:

1. **Management by exception.** The manager reviews every worker completion
   itself — claims vs. evidence, lane audit, checks. Clean completions simply
   appear as done, digest attached. Only failures, contradictions, staleness,
   and genuine direction calls escalate to the user.
2. **The manager owns the cognitive load.** It holds project understanding,
   routes context to the right workers, relays workers' questions upward with
   its own recommendation, and never lets the user discover a problem the
   system already had evidence for.

## The manager

The manager is a conversation the user has inside the app — a colleague, not a
dashboard. It is also the spinal cord connecting every subsystem: it writes the
durable memory records, spawns and steers workers, requests checks, resolves
attention items, and asks the user questions when — and only when — an answer
would change the work. Trust between user and manager is built the same way as
with a human lead: it states what it understands, exposes its assumptions, and
distinguishes what it observed from what it was told.

## Completion digests replace text blobs

When a worker finishes, the user absorbs the result through four layers, in
order. Raw agent prose is never the interface.

1. **Tiny narrative** — three sentences max. The headline.
2. **Before/after in product terms** — "you could X, now you can Y." What
   changed for the product, not which files changed.
3. **Visual change map** — the touched areas of the codebase, sized by change
   magnitude, colored by risk: in-lane, tested, untested, out-of-lane.
4. **Claim checklist with evidence badges** — every claim the worker made as a
   row with a verified / unverified / contradicted badge, proof one click away.

Raw transcripts and diffs exist, but only behind drilldowns. A completion
without a structured report is not rendered as done — it is an attention item.

## Claims are not truth

A worker saying "done and tested" is a claim. Git state, check runs, and
deterministic evals are evidence. Confidence — the one gauge the cockpit shows —
measures whether work can proceed without intervention, and it is computed from
evidence, never from how confident an agent sounds. Unsupported claims lower it.
Contradicted claims cap it hard. Missing evidence is never rendered as quiet
health.

## Feel: calm mission control, with chat

Quiet by default — whitespace, muted state, nothing demands attention that
doesn't need it. The interface raises its voice only for open attention items.
The manager chat is a core surface. Every worker thread is clickable into a
drilldown: the goal at its inception, what it claims, what actually changed,
what the evidence says. The user should be able to glance, absorb, and return
to thinking about direction.

## The bloodline

Every major decision is a committed, checkpointed node in the project's
lineage — its own page, separate from the daily surfaces. The bloodline shows
how the project became what it is, and any node can be resumed: a clean
worktree materializes from that point in history and work forks visibly from
there. Wrong turns are cheap because the road back is always mapped.

## What Galapagos never does

- Render agent text blobs as a default surface.
- Treat a claim as truth without linked evidence.
- Let two workers touch the same files (lanes are exclusive; violations are
  detected, surfaced, and capped in confidence).
- Skip a safety step silently — a checkpoint that can't be taken becomes an
  attention item, never an omission.
- Interrupt the user with anything the manager could have resolved itself.
