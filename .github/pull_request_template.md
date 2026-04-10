## What changed

<!-- For daemon PRs: the Stratos Games Factory fills this in from Claude's summary.
     For human PRs: describe what you changed and why in one or two sentences. -->

## How to test

1. Open the preview URL — it will be posted as a comment on this PR by the `PR Preview` workflow.
2. [ ] Game loads without errors (white screen = failure).
3. [ ] Main menu appears and the Play button is clickable.
4. [ ] Start a game — does the new feature / fix work as described?
5. [ ] Play through at least 3 levels — no regressions on existing mechanics?
6. [ ] Check on mobile (open the preview URL on a phone browser).

## Device testing checklist

- [ ] Chrome desktop
- [ ] Safari iOS
- [ ] Chrome Android
- [ ] Samsung Internet

## What to look for

<!-- For daemon PRs: the Stratos Games Factory fills this in with the file list and a focus hint.
     For human PRs: tell the reviewer what to pay attention to. -->

---

<!-- Reviewer notes:
     - The `QA` workflow runs an automated Playwright smoke test. If it comments
       🟢 this PR cleared the cheapest visual QA. If it comments 🔴 the PR is blocked.
     - The `PR Preview` workflow deploys the build to gh-pages under /pr/<num>/
       and comments the URL. Test on that preview, not on main.
     - If this PR has the `auto-merged` label after it's closed, it shipped
       to production automatically because the diff only touched data/asset files.
-->
