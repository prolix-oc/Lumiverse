# Contributing to Lumiverse

Thank you for contributing. Keep pull requests focused, reviewable, and ready to validate against the current staging build.

## Pull request requirements

Before opening a pull request:

- Base your work on the latest `staging` branch. Target `staging` with your pull request; do not develop against or target `main`.
- Run the appropriate type check with no type errors or warnings:
  - Backend (from the repository root): `bun x tsc --noEmit`
  - Frontend (from `frontend/`): `bun run typecheck`, then `bun run lint`
- Run all applicable unit tests and ensure they pass.
- For UI changes, validate the change in more than one browser where practical. Also verify the integrated experience on a mobile interface or through the mobile PWA.
- Keep security-sensitive backend work separate from UI/UX changes. Changes that affect or encroach on the Spindle system or other security systems require separate pull requests and auditing; do not bundle them into UI/UX pull requests.
- For performance-oriented pull requests, include tests and reproducible benchmarks. Describe how reviewers can run the benchmark and compare the result.
- For LLM-assisted code, the human orchestrating the work must audit the submitted changes in a live environment before opening the pull request.

## Pull request description

Explain what changed, why it changed, and how you validated it. Include the commands run, test results, browser/mobile coverage for UI work, and benchmark instructions and results for performance work. Call out any security-sensitive areas explicitly so they can receive the required audit.
