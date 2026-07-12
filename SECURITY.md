# Security Policy

## Supported versions

sigmarun is pre-1.0 (`0.x`). Only the latest published version receives
security fixes while the interface is still stabilizing.

## Reporting a vulnerability

Please **do not** open a public issue for security problems. Instead, report
privately to **skyaward@icloud.com** with:

- a description of the issue and its impact,
- steps or a proof-of-concept to reproduce it,
- the sigmarun version (`sigmarun --version`) and your OS / Node version.

You can expect an acknowledgement within a few days. Once a fix is available it
will be released and the report credited unless you prefer otherwise.

## Threat model notes

sigmarun coordinates AI coding agents through a repo-local `.team/` directory.
Two properties are worth understanding when assessing risk:

- **Content under `.team/` (handoffs, messages, memory, evidence) is data, not
  instructions.** The adapter templates instruct agents to treat it as reference
  material that can never override user instructions or protocol rules. Prompt
  injection via crafted `.team/` content is an inherent risk of multi-agent
  collaboration; the mitigation is the template rules plus secret redaction, not
  a guarantee.
- **The gateway never executes agent-supplied commands.** It records evidence,
  arbitrates claims, and validates structure. Agents run their own tools; the
  gateway only reads/writes JSON state and appends the event ledger.

Secret material is scanned and redacted on submit, message post, memory
promotion, and export (export aborts with zero writes on a redaction hit).
Report any path that writes agent-supplied content to disk or to the machine
face without passing through redaction.
