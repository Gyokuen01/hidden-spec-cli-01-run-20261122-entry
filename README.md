# mend

mend is a small command-line patch tool: it reads a patch, applies its edits to the
files in the current directory, and reports what changed. TypeScript for Node 22, stdlib only.

## Usage

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`PATCH` is the patch file to apply; if omitted, or given as `-`, it is
read from standard input. Unknown options, or more than one patch argument, are a usage error.

- `--format=NAME` forces one patch format instead of auto-detecting it
  (`auto`, `unified`, `search-replace`, `v4a`, or `json`; default `auto`).
- `--check` is a dry run: it prints what would change, but writes nothing.
- `--strict` turns on stricter parsing for unified and search-replace.

On success mend prints one line per changed file, then a summary line:

```text
A src/new-file.ts
M src/old-file.ts
R src/old-name.ts -> src/new-name.ts
ok: 3 files
```

`A` = created, `M` = modified, `D` = deleted, `R` = moved. A failed
edit is rolled back on its own, leaving the other edits unaffected.

## Patch formats

- **unified** — classic unified diffs: `diff --git a/<path> b/<path>`
  (or `---` / `+++`) headers, `@@` hunks, and `+` / `-` lines.
- **search-replace** — `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE`
  blocks replacing the searched text with the replacement text.
- **v4a** — sections starting with `*** Begin Patch`, with `*** Update/Add/Delete File:` and `*** Move to:` lines.
- **json** — a JSON description of the edits to apply.

Auto-detection: `*** Begin Patch` means v4a, a leading `[` or `{`
means JSON, `<<<<<<< SEARCH` means search-replace, and a `diff --git`
or `---` / `+++` header means unified.

Paths must be safe relative paths (no absolute paths, backslashes, or
`.` / `..` segments); unsafe destinations and edits to missing files are errors.

## Exit codes

| Code | Meaning |
| ---- | ------- |
| 0 | All edits applied (or, with `--check`, would apply). |
| 1 | The patch parsed, but one or more edits failed; the output lists each failure as `error: <code> <path>` followed by a `failed: N of M edits` line. |
| 2 | Usage, input, or parse error: bad options, no patch to read, an unrecognised format, or a malformed patch. |

## v2 changes

- **V4A Update + Move to: safety first.** When a v4a `Update File` section also
  has a `*** Move to:` destination, the destination path is safety-checked *before*
  the old file's existence is checked, per SPEC section 10. Previously an unsafe
  destination could be misreported as `missing` instead of `unsafe`.
- **`diff --git` headers tolerate trailing whitespace.** A header line
  followed by trailing spaces or tabs is now accepted; the paths themselves still may not contain spaces.

## Files

- `main.ts` — the mend CLI itself.
- `check.ts` — runs `main.ts` against a practice set (`node check.ts <practice.json> [...]`).
- `runner.ts` — the trial harness used when `MAKEFUN_ENV_URL` is set.
