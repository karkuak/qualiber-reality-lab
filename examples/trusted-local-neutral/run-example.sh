#!/usr/bin/env bash
# The complete neutral trusted-local worked example, end to end, from committed
# material only.
#
#   ./examples/trusted-local-neutral/run-example.sh
#
# Precondition: `npm ci && npm run build` has been run in this workspace. The
# CLI is invoked as `node packages/cli/dist/src/bin.js`, which is the form the
# documented Quick Start actually supports — nothing puts an `erl2` binary on
# PATH.
#
# Everything this script generates — the sealed manifest, the sealed plan, the
# owner declaration, the observation output tree and its record — is written
# into a fresh `mktemp -d` scratch root and never into the repository. The
# script prints that path at the end and does not remove it: the run is only
# worth anything if the operator can read what it produced. Remove it with
# `cleanup-example.sh`, which refuses to remove anything else.
#
# The script starts one child process per operation, each of which the Lab's own
# supervisor terminates as a process tree. It starts no daemon, opens no
# listener and no socket, and creates no container, network or volume.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
EXAMPLE_DIR="$REPO_ROOT/examples/trusted-local-neutral"
# Every CLI invocation below is relative to the repository root, so the script
# works from any working directory while still showing the exact command a
# reader would type there.
cd "$REPO_ROOT"

CLI="packages/cli/dist/src/bin.js"
if [ ! -f "$CLI" ]; then
  printf 'the CLI is not built: %s is missing. Run `npm ci && npm run build` first.\n' "$CLI" >&2
  exit 1
fi

# The exact sentence the contract pins. Not a flag, not a --yes: the operator
# reproduces it verbatim, and it is retained in the declaration and in the run
# record.
ACKNOWLEDGEMENT="I ACCEPT THAT THESE EXACT ADAPTER BYTES EXECUTE WITH MY LOCAL USER PERMISSIONS, ARE NOT SANDBOXED AND ARE NOT INDEPENDENTLY CERTIFIED, AND THAT THE RESULTS ARE DEVELOPMENT-ONLY, UNSCORED AND UNAUTHENTICATED"

ADAPTER_ENTRY="fixtures/neutral/neutral-full-lifecycle-observer.mjs"

SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/erl2-trusted-local-neutral-XXXXXXXX")"
# The stamp cleanup-example.sh requires before it will remove anything.
printf 'created by examples/trusted-local-neutral/run-example.sh\n' > "$SCRATCH/.erl2-trusted-local-neutral-scratch"

printf '== scratch root: %s\n' "$SCRATCH"

printf '\n== 1/4 seal the adapter manifest (build-manifest.mjs)\n'
node examples/trusted-local-neutral/build-manifest.mjs "$SCRATCH/manifest.json"

printf '\n== 2/4 declare the trusted-local adapter and seal the plan draft\n'
node packages/cli/dist/src/bin.js declare-trusted-local-adapter \
  --adapter-entry "$ADAPTER_ENTRY" \
  --manifest "$SCRATCH/manifest.json" \
  --acknowledge-trusted-local-code "$ACKNOWLEDGEMENT" \
  --acknowledged-by "trusted-local neutral example operator" \
  --declaration-id "trusted-local-neutral-example" \
  --output "$SCRATCH/declaration.json" \
  --seal-plan-draft examples/trusted-local-neutral/plan.draft.json \
  --plan-output "$SCRATCH/plan.sealed.json"

printf '\n== 3/4 run the trusted-local observation with the committed input bound\n'
node packages/cli/dist/src/bin.js run-trusted-local-observation \
  --adapter-entry "$ADAPTER_ENTRY" \
  --manifest "$SCRATCH/manifest.json" \
  --plan "$SCRATCH/plan.sealed.json" \
  --owner-declaration "$SCRATCH/declaration.json" \
  --output-root "$SCRATCH/output" \
  --bind-input "package-input=$EXAMPLE_DIR/input/package.bin" \
  | tee "$SCRATCH/run-summary.json"

printf '\n== 4/4 verify, independently, in this fresh process\n'
node examples/trusted-local-neutral/verify-example.mjs "$SCRATCH/output" "$SCRATCH/run-summary.json"

printf '\n== done. Nothing was written into the repository.\n'
printf '== scratch root (remove it explicitly): %s\n' "$SCRATCH"
printf '==   ./examples/trusted-local-neutral/cleanup-example.sh %s\n' "$SCRATCH"
