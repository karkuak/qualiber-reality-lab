# Quarantined attempts — none

**Count: 0.** No Wave 2 scenario produced a missing record, a failed offline verification, a broken
binding or an oracle-absence scan hit, so nothing was quarantined and **no scenario was re-run**.
All three scenarios are admitted under `scenarios/` and all three are counted in the verdict tally.

This directory exists and says so explicitly, because silence about re-runs would misrepresent how
the evidence was obtained (plan §13.1).

Two non-scenario attempts are recorded elsewhere and deliberately do **not** appear here, because
neither is a scenario attempt:

**The relative-anchor tooling-test run.** The first re-run of the unchanged comparator tests
reported `T5` failing. The cause was an operator invocation defect — `--retain-fixtures` passed as a
relative path, which made the anchor the test derives relative too. The comparator refused it
correctly with a hard tooling exit 3 (`createRequire failed for anchor … must be … absolute path
string`; `no scenario was evaluated; this is not a verdict.`), which is a different legitimate
tooling exit from the `cannot resolve @erl2/… MODULE_NOT_FOUND` that T5 asserts. The unchanged test
passes 12 of 12 with an absolute path. **No script or fixture was edited.** Both invocations appear
in `../commands/command-log.tsv`, and the diagnosis is in `../plan/campaign-plan-application.md`
§3.1.

**No aborted negative control.** Unlike Wave 1, Wave 2's NC-5 did not abort: the corrected procedure
was precommitted in advance, the copy was made writable, and the one-byte change was **proven by
digest** before either leg ran. See `../negative-controls/NC-5.result.json`.
