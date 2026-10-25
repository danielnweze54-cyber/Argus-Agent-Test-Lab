# Engagements — per-client test campaigns

One folder per client engagement. The engine and canonical scenarios stay in
`src/` (single source of truth); an engagement adds only what is specific to
that client: scope, custom connectors, raw run artifacts, and client-facing
reports. Branches are used only for long-lived connector development (merged
back to main when done); campaign runs themselves produce artifacts, not code.

```
engagements/<client-id>/
  plan.md        scope: which blocks/families run, knobs, windows, funding
  connectors/    custom SUT adapters (code), if the SUT needs one
  runs/<date-id>/
                 raw session logs and client/stand captures
  findings.md    verdicts + F-findings per run (working notes)
  report/        client-facing documents
```

Sealed, hash-chained verdicts go to the global `attestations/records/`
(content-addressed, tagged with the client/system), never into the engagement
folder — the engagement references seals by ID.

Existing engagements:

- [`zeus-secretariat/`](./zeus-secretariat/) — Zeus Insurance BOT secretariat
  (PG + mock stand), first capability audit; seeded retroactively from files
  that previously lived under `src/tests/`.
