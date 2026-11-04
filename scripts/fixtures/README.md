# Test fixtures

Most files here are small documents written for one test.

Third-party test data (used as a corpus by `scripts/test-spec-corpus-ui.mjs`):

| File | Source | License |
|---|---|---|
| `commonmark-spec-0.31.2.json` | https://spec.commonmark.org/0.31.2/spec.json — the examples of the CommonMark Spec 0.31.2 (John MacFarlane) | CC BY-SA 4.0 |
| `gfm-spec-extensions.json` | the `example <extension>` blocks of https://github.com/github/cmark-gfm/blob/master/test/spec.txt — the GitHub Flavored Markdown Spec (GitHub, Inc.; based on the CommonMark Spec) | CC BY-SA 4.0 |

Both are unmodified apart from extracting the examples (`→` in the GFM spec
text is a tab, as the spec defines).
