# Incident Response Playbook (GDPR)

## Purpose
Define the operational process for identifying, containing, assessing, and reporting personal data incidents.

## Scope
- Applies to INTERNAL, REST, and PAPERLESS data handled by hcs-app.
- Includes incidents involving hcs-sync inputs where personal data may be affected downstream.

## Roles
- Incident Lead: Engineering lead on-call.
- Privacy Owner: DPO or nominated privacy contact.
- Security Owner: Infrastructure/security lead.
- Business Owner: Department lead for impacted process.

## Severity
- `sev1`: Confirmed breach with likely risk to rights/freedoms.
- `sev2`: Confirmed unauthorized access with limited scope.
- `sev3`: Security event without confirmed personal data impact.

## First 60 Minutes
1. Open incident record with timestamp, reporter, and affected systems.
2. Contain exposure: revoke credentials, rotate keys, block endpoints, isolate hosts.
3. Preserve evidence: logs, request IDs, deployment hashes, and DB snapshots.
4. Start impact triage: categories of data, records affected, and potential recipients.

## 24-Hour Actions
1. Confirm root cause and blast radius.
2. Validate data categories and subject groups impacted.
3. Assess harm likelihood and severity.
4. Decide if ICO notification is required.

## 72-Hour Rule (UK GDPR)
If reportable, submit ICO notification within 72 hours of awareness.

Notification package should include:
- Incident nature and timeline.
- Data categories and approximate volume.
- Affected subject categories.
- Likely consequences.
- Containment and remediation actions.
- Contact details for follow-up.

## Data Subject Notification
Notify affected data subjects without undue delay when high risk is likely.

Include:
- What happened.
- What data may be affected.
- What actions were already taken.
- What users should do next.
- Support contact channel.

## Evidence Checklist
- Incident UUID and chronology.
- Query extracts and affected record counts.
- Relevant application and infrastructure logs.
- Access audit trail and auth/session indicators.
- Changes applied (commits, config, infrastructure updates).

## Post-Incident Review
Within 5 business days:
1. Complete root cause analysis.
2. Record corrective and preventive actions.
3. Update RoPA, DPIA, and controls where required.
4. Validate closure with privacy owner.
