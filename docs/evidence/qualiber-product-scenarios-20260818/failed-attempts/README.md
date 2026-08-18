# Quarantined attempts — none

**Count: 0.** No scenario in this campaign produced a missing record, a failed offline verification,
a broken binding or an oracle-absence scan hit, so nothing was quarantined and no scenario was re-run.
All five scenarios are admitted under `scenarios/` and all five are counted in the verdict tally.

This directory exists and says so explicitly, because silence about re-runs would misrepresent how
the evidence was obtained (plan §13.1).

One aborted *negative-control* attempt is recorded, but it is not a scenario attempt and does not
belong here: NC-5's first run mutated nothing because the host writes retained inputs mode `0444`.
It is recorded in `../negative-controls/NC-5.result.json` and explained in
`../negative-controls/README.md`.
