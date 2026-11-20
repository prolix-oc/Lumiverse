# Security Policy

## Supported Versions

We actively support the latest commit on the `main` and `staging` branches. Security fixes are applied to `staging` first, then promoted to `main`.

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, report them privately via [GitHub Security Advisories](https://github.com/prolix-oc/Lumiverse/security/advisories/new) or by emailing the maintainers directly at **info@prolix.dev**.

### Before You Report

To ensure we can triage your report efficiently, **please verify that the vulnerability is reproducible on the latest commit of the `staging` branch** before submitting your disclosure. This helps confirm the issue is present in the current development state and has not already been addressed.

### What to Include

When reporting, please provide the following details:

1. **Description:** A clear and concise description of the vulnerability.
2. **Reproduction Steps:** Step-by-step instructions to reproduce the issue. If applicable, include a minimal proof-of-concept (PoC).
3. **Environment:** Confirm that you have tested this against the latest `staging` commit. Include the specific commit hash if possible.
4. **Impact:** An assessment of the potential impact (e.g., data exposure, unauthorized access, denial of service).
5. **Scope:** Identify the affected component(s) (e.g., `src/routes/`, `src/services/`, `frontend/`, `src/spindle/`).
6. **Screenshots/Logs:** Any relevant logs, screenshots, or output that can help us understand the issue.

## Response Timeline

- **Acknowledgment:** We will acknowledge receipt of your report within **3 business days**.
- **Investigation:** We will investigate and validate the vulnerability. We may reach out to you for additional information.
- **Fix & Disclosure:** Once a fix is prepared, we will coordinate with you on a responsible disclosure timeline. We aim to disclose the issue publicly within **90 days** of the initial report, or sooner once a patch is widely available, whichever comes first.

## Disclosure Policy

We follow a coordinated disclosure policy. We ask that you:

- Give us a reasonable amount of time to address the vulnerability before disclosing it to the public or third parties.
- Avoid exploiting the vulnerability beyond what is necessary to confirm its existence.
- Avoid accessing, modifying, or deleting data that does not belong to you.

We appreciate your efforts to responsibly disclose your findings and will publicly acknowledge your contribution in our release notes or security advisory, unless you prefer to remain anonymous.

## Scope

The following components are in scope for security reports:

- Backend API (`src/routes/`, `src/services/`, `src/db/`)
- WebSocket handlers (`src/ws/`)
- Frontend application (`frontend/`)
- Spindle Extension runtime (`src/spindle/`)
- Authentication and authorization mechanisms

## Out of Scope

The following are generally considered out of scope unless they can be chained to demonstrate a material security impact:

- Self-XSS (XSS requiring user interaction with their own account)
- CSRF on non-state-changing or unauthenticated endpoints
- Denial of Service (DoS) using purely excessive traffic (rate-limiting bypasses are in scope)
- Issues related to outdated dependencies without a demonstrated exploit path
