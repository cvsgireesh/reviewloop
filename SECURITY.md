# Reporting a vulnerability

Report suspected vulnerabilities privately through [GitHub private vulnerability reporting](https://github.com/cvsgireesh/reviewloop/security/advisories/new). Do not publish an exploitable reproduction or sensitive logs in a public issue.

Include the affected version or commit, relevant configuration with secrets removed, expected versus observed behavior, and a minimal reproduction using synthetic files. Approval bypasses, credential exposure, sandbox escapes, and mismatches between tested and published code are particularly relevant.

Never submit real tokens, private source code, customer data, or complete state directories. If private reporting is unavailable, open a minimal public issue requesting a private reporting channel without disclosing the vulnerability details.

ReviewLoop is an early implementation. No response-time or supported-release guarantee is offered. Read [the security boundaries and limitations](docs/SECURITY.md) and [recorded validation](docs/VALIDATION.md) before deploying it. Passing tests is not evidence that a particular host or worker image is isolated.
