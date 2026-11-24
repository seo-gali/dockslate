---
name: delete-comment
description: Classify and remove first-party code comments, move decisions to ADRs, record implementation issues, and tighten DockSlate's comment ratchet when asked for comment cleanup.
---

# Delete Comment

Use this repository skill for a `/delete-comment` request or an equivalent comment cleanup. Read `docs/COMMENT_POLICY.md` and the relevant caller before deciding what a comment means.

- Get the current inventory with `node scripts/check-comments.mjs --inventory`. Limit edits to the requested first-party scope. Preserve legal originals, vendor code, generated artifacts, strings and embedded script data.
- Classify every targeted comment. Delete Tautology and Stale. Delete Excuse and record a concrete issue with the failure mode and acceptance criteria. Move Decision Record explanations into a relevant `docs/adr/` entry; avoid one ADR per trivial sentence.
- Keep executable shebangs and compiler directives when removing them would change behavior or weaken a negative test. Move their explanation to an ADR. Explain any functional exception in the baseline.
- Record the original location, text, classification and destination in `docs/results/comment-review.json` or a new dated review. Do not rewrite historical release evidence. Update the ADR index when adding a decision.
- Run `node scripts/check-comments.mjs --ratchet` after deletions. It may only shrink the existing baseline. Do not rebuild the baseline from the inventory to hide new comments. A new functional directive needs an explicit, justified baseline review.
- Run `npm run check` and checks appropriate to changed languages. Report removed whole lines separately from inline text and retained directives; documentation and lint additions are not code-line savings.
- Repository issue files belong in `docs/issues/`. If an authenticated GitHub issue tool is available and publication is authorized, register the issue and record its URL; otherwise report that no remote issue was created. This skill grants no push, publication or credential-reading permission.
