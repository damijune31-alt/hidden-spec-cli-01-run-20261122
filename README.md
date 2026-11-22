# mend — one patch tool for every AI edit format

[![make.fun](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/damijune31-alt/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/damijune31-alt/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122)

Entry for [hidden-spec-cli-01-run-20261122](https://make.fun/bounty/hidden-spec-cli-01-run-20261122) on make.fun: build `mend`, one CLI that applies AI-written edits in four formats to a tree of files, exactly as `SPEC.md` says.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is a patch file, or `-` / absent for stdin. Formats: `auto` (default),
`unified`, `search-replace`, `v4a`, `json`.

- Exit `0`: one line per changed file, then `ok: <n> files`.
- Exit `1`: `error: <code> <path>` per failed edit, then `failed: <k> of <n> edits`.
  No file is written at all when any edit fails (atomicity).
- Exit `2`: `error: usage` / `error: no-patch` / `error: format` / `error: parse <N>`.

Line matching is fuzzy in three tiers (exact; trailing whitespace ignored;
leading + trailing whitespace ignored with re-indentation), `--strict` pins it
to exact matching only. Unified diffs tolerate wrong hunk line numbers by
taking the nearest occurrence. `runner.ts` is the kit's trial runner, kept
as-is: when `MAKEFUN_ENV_URL` is set, `main.ts` hands the trial over to it.

## Results

- Practice: **100/100, score 1000** (unified 30/30, search-replace 20/20,
  v4a 20/20, json 15/15, cli 15/15).
- Adversarial, beyond practice: 88/88 hand-crafted cases, 250/250 oracle
  fuzz + 250/250 invariant fuzz, 742/763 practice mutations (the 21 misses
  verified spec-correct / harness artefacts, zero real bugs found).

## Files

- `main.ts` — the `mend` CLI (Node 22, standard library only).
- `runner.ts` — the kit's trial runner (MIT, unchanged from the starter).
- `LICENSE` — MIT.
