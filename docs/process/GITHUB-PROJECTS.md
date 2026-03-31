# GitHub Projects (team workflow)

Use **GitHub Projects (new)** for roadmap and backlog so triage, priority, and ownership stay visible next to code. Issues stay in `8gi-foundation/8gent-code`; the Project is the planning surface.

**Live org project:** [8gent-code roadmap](https://github.com/orgs/8gi-foundation/projects/1) (project `1`). Linked to `8gi-foundation/8gent-code`. Epic **#1076** and issues **#1077–#1093** are already on the board.

## One-time: CLI access

The `gh` token must include the **project** scope:

```bash
gh auth status
gh auth refresh -s project -h github.com
```

Complete the device flow in the browser if prompted.

Verify:

```bash
gh project list --owner 8gi-foundation --limit 5
```

## Create an org project and link the repo

Skip this section if you use the [live project](https://github.com/orgs/8gi-foundation/projects/1) above.

1. **Create** (org-owned project, visible to the org):

   ```bash
   gh project create --owner 8gi-foundation --title "8gent-code roadmap"
   ```

   Note the **project number** from the output (or `gh project list --owner 8gi-foundation`).

2. **Link** the repository so it appears under the repo’s Projects tab:

   ```bash
   cd /path/to/8gent-code
   gh project link <PROJECT_NUMBER> --owner 8gi-foundation --repo 8gi-foundation/8gent-code
   ```

3. **Open in browser** (optional):

   ```bash
   gh project view <PROJECT_NUMBER> --owner 8gi-foundation --web
   ```

## Recommended fields (in the Project UI)

GitHub provides **Status**, **Assignees**, and **Labels** from issues. Add project fields as needed:

| Field        | Type           | Purpose                                      |
| ------------ | -------------- | -------------------------------------------- |
| **Priority** | Single select  | `P0`, `P1`, `P2`, `Later` (triage)           |
| **Area**     | Single select  | Optional: harness, TUI, daemon, docs, etc.   |

Create Priority once; triage **#1076** epic and children **#1077–#1093** there.

**Tip:** Use a **Table** view grouped by **Priority**, filtered by **Assignee** is empty, for triage. Use a **Board** by **Status** when execution starts.

## Bulk-add roadmap issues (script)

After `PROJECT_NUMBER` is known, from repo root:

```bash
export GITHUB_PROJECT_NUMBER=<number>
./scripts/gh-project-roadmap.sh
```

Defaults: owner `8gi-foundation`, repo `8gi-foundation/8gent-code`, issues `1076` and `1077–1093`. Override:

```bash
export GITHUB_PROJECT_OWNER=8gi-foundation
export GITHUB_REPO=8gi-foundation/8gent-code
export GITHUB_PROJECT_NUMBER=1
./scripts/gh-project-roadmap.sh
```

Re-running may create **duplicate** project rows for the same issue; prefer running once, then manage in the UI.

## Triage: P0 / P1 and owners

1. In the Project **Table** view, set **Priority** for each row (`P0` = unblock or security; `P1` = next; `P2` / `Later` = backlog).
2. Set **Assignees** on the issue (or from the issue sidebar); the Project picks them up.
3. Use **Milestone** or labels (`area:*`) if you need reporting across Projects.

## Merge `fix/daemon-usage-gate` to land docs on `main`

When CI is green:

1. Open a PR from `fix/daemon-usage-gate` to `main` (or merge per team policy).
2. Link the PR to the same Project; move Status to **Done** when merged.

Related research epic: **#1076** (claw-code harness patterns); child issues **#1077–#1093**.

## References

- [GitHub CLI: `gh project`](https://cli.github.com/manual/gh_project)
- [About Projects](https://docs.github.com/issues/planning-and-tracking-with-projects/learning-about-projects/about-projects)
