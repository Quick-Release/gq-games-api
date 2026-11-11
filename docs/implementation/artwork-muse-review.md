# Muse artwork review and corrections

Muse Wonder Full reviewed PR #24 at `c467be737c4b231303599a157d387978750dbf39`
against `e02bc911c95f84e27dac4d3d670cf4c1230dbd53` on 2026-11-11. The parent
independently checked the report and reproduced the actionable validation
behavior before changing code. No production or real artwork source was
accessed.

## Findings assessed

| Finding                         | Assessment and action                                                                                                                                                                                                                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Future observation time         | Confirmed: the server clock was passed but unused. The old artwork contract had no future ceiling, unlike the existing catalog convention. An hour-ahead observation was applied through HTTP, allowing honest later observations to be classified stale. Added the catalog's 300-second tolerance, with a safe 422 and no mutation. |
| Duplicate-scope coverage        | Confirmed test gap, not a broken guard. Real registry HTTP now rejects repeated artwork/catalog grants with 422 and proves the prior record unchanged. No grants or registry semantics were widened.                                                                                                                                 |
| Edge whitespace                 | Confirmed convention divergence rather than an explicit violation of the former artwork contract. Aligned text validation with the catalog: reject edge whitespace, preserve internal spaces and Unicode. The normative contract records the stricter rule.                                                                          |
| Canonical delivery origins      | Not a defect: origin membership intentionally uses URL origin semantics, while provider/provenance/rights match exactly. Documented the distinction and proved host case/default HTTPS port equivalence through HTTP, retaining the submitted URL spelling. Different origins remain denied.                                         |
| Repeated D1 error classifier    | Confirmed maintainability concern. Both services now use one shared classifier; existing catalog error-mapping tests pass unchanged.                                                                                                                                                                                                 |
| Database/layout docs            | Confirmed stale overview. Added artwork tables, trigger, modules and scope migration details; kept local implementation separate from hosted deployment history.                                                                                                                                                                     |
| Observation rollback coverage   | Added a real later-statement SQL failure to an observation batch, proving the previously published representation and control remain unchanged.                                                                                                                                                                                      |
| No Node-only artwork HTTP suite | No observed defect. The approved composed HTTP/workerd/D1 boundary already exercises these routes. Added focused pure-validation tests for exact clock/whitespace boundaries instead of duplicating the integration suite with service mocks.                                                                                        |

## Reproduction and verification

Before the fix, `pnpm test tests/artwork-validation.test.ts` failed both new
validation tests: `now + 301`/millisecond timestamps and padded text were
accepted. The local workerd command
`pnpm test:integration tests/integration/catalog.test.ts` then failed with HTTP
200 `applied` where the hour-ahead regression expected 422 (38.80 seconds).

After the fix, focused validation/error-mapping tests passed (7 tests). Pure
validation checks prove exactly `now + 300` is accepted, `now + 301`,
milliseconds and the maximum safe integer are rejected, and accepted internal
whitespace and Unicode are preserved. The composed HTTP checks prove future
rejection cannot replace the current asset and later valid revisions still
apply.

Final verification passed: format, check, lint, 14 files / 206 Node tests,
offline build, migration check, and all three local workerd/D1 tests (56.01
seconds). The integration run also includes scope record preservation,
observation rollback, origin equivalence and all previous lifecycle races. No
migration or infrastructure declaration changed in these corrections.
