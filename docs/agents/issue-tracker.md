# Issue tracker: GitHub

Issues, specs, and tickets live in `Quick-Release/gq-games-api`. Use the `gh`
CLI from this clone; pass `--repo Quick-Release/gq-games-api` when working
elsewhere.

## Conventions

- Create: `gh issue create --title "..." --body-file <file>`.
- Read: `gh issue view <number> --json number,title,body,labels,comments`.
- List: `gh issue list --state open --json number,title,body,labels,comments`.
  Add label and state filters as needed.
- Comment: `gh issue comment <number> --body-file <file>`.
- Label: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- Close: `gh issue close <number> --comment "..."`.

Publishing to the issue tracker means creating a GitHub issue. Fetching a
relevant ticket means reading that issue.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## Parent tickets and dependencies

Use GitHub's native sub-issues and issue dependencies.

The installed gh CLI is currently older than 2.94, so use API calls:

- Get an issue's database ID:
  `gh api repos/Quick-Release/gq-games-api/issues/<number> --jq .id`.
- Attach a child:
  `gh api --method POST repos/Quick-Release/gq-games-api/issues/<parent>/sub_issues -F sub_issue_id=<child-db-id>`.
- Add a blocker:
  `gh api --method POST repos/Quick-Release/gq-games-api/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`.

API IDs are numeric database IDs, not issue numbers or node IDs. If native
relationships are unavailable, put `Part of #<parent>` and
`Blocked by: #<number>, #<number>` at the top of ticket bodies and list children
in the parent.

## Wayfinding

- Map: one issue labelled `wayfinder:map`, with Notes, Decisions-so-far, and Fog
  sections.
- Children: linked tickets labelled `wayfinder:<type>`, where type is research,
  prototype, grilling, or task.
- Frontier: first open child in map order with no assignee or open blocker.
  Native `issue_dependencies_summary.blocked_by` counts open blockers.
- Claim: `gh issue edit <number> --add-assignee @me`.
- Resolve: comment with the answer, close the ticket, and append a summary and
  link to the map's Decisions-so-far.
