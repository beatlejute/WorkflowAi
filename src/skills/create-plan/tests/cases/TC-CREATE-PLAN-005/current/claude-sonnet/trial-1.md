Validator needs `workflow-ai` package, not installed in this sandbox — infra gap, not plan issue (matches known env limitation). Manual checklist self-review passed: all 7 required sections present, no red-flag phrases, reference-data section filled, each task carries result-based acceptance criterion citing 600px cap / scroll / availability, verification pair (задача 3) covers tasks 1-2 with explicit combine justification, autotest task 4 has isolation/teardown note.

Plan saved: `.workflow/plans/current/PLAN-001.md`, status `draft`.

4 tasks: 1) stretch root container to available height (≤600px cap), 2) internal scroll for list, 3) combined manual QA for both, 4) automated test (add or update) for height + scroll. Risks: `100vh` platform mismatch, flex-chain break between root and list, missing test infra.
