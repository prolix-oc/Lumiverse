## Summary

Describe what changed and why.

## Validation

List the commands you ran and their results. Include any relevant test output.

```text
# Example
bun x tsc --noEmit
cd frontend && bun run typecheck
```

## Required checklist

- [ ] This pull request is based on the latest `staging` branch and targets
      `staging`, not `main`.
- [ ] All applicable tests pass.
- [ ] I ran the relevant type check(s) with no type errors or warnings:
  - [ ] Backend: `bun x tsc --noEmit`
  - [ ] Frontend: `cd frontend && bun run typecheck`

## UI changes (if applicable)

- [ ] I validated this change in more than one browser.
- [ ] I verified the integrated experience on a mobile interface or through
      the mobile PWA.
- Browsers, devices, and PWA coverage:

## Performance changes (if applicable)

- [ ] I added or updated tests.
- [ ] I included reproducible benchmarks and comparison results below.
- Benchmark commands and results:

## Security-sensitive changes (if applicable)

Describe any impact on Spindle or other security systems, including the audit
required for this change. Security-sensitive backend changes must be submitted
and audited separately from UI/UX changes.

## LLM-assisted work (if applicable)

- [ ] I, as the human orchestrating this work, audited the submitted changes
      in a live environment.
