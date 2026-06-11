# STN Privacy & Data Governance

The in-app `/privacy` page renders this policy for end users; this file is the engineering source.

## Principles

**Data minimization by default** — email, name (pseudonyms fine), password hash, consent flags with
timestamps, and contributions. No advertising IDs, no third-party trackers, no analytics beacons,
no model training on user content.

## Inventory & retention (enforced by `retention_enforcement`, daily)

| Data | Purpose | Retention |
| --- | --- | --- |
| Account (email/name/hash/consents) | auth, invites, reminders | active life + 30-day anonymization grace after deletion |
| Contributions (assets/evidence/disputes/comments) | the public dataset | preserved, **de-attributed** after account deletion |
| Security audit logs (incl. IP) | integrity & abuse defense | 730 days → archived to object storage (JSONL) → pruned |
| Exports | user downloads | 72 h, then files deleted |
| Idempotency keys | duplicate-write protection | 48 h |
| Notifications (read) | UX | 90 days |
| Mail outbox (dev only) | local testing | developer-managed |
| Device caches (IndexedDB) | offline mode | user-clearable; SHA-256 verified |

## Rights implementation

- **Access/portability**: `GET /users/me/data` (full JSON) — also a one-click download in Settings.
- **Deletion**: `DELETE /users/me` — instant deactivation + session revocation + email release;
  hard anonymization within 30 days by the retention job. Admin-initiated deletion identical + audited.
- **Rectification**: profile self-service; any record disputable with mandatory resolution.
- **Consent**: granular, timestamped, revocable (`consent_flags`); research-contact is opt-in.

## Community-safety policy (PII in the dataset)

The platform documents infrastructure, not people. Uploads are scanned; suspected PII (SSNs,
card numbers via Luhn, phones, emails, DOBs) flags the file for human review before any public
display; malware-suspect files are quarantined and never published. Submission UI states the
public-space/no-faces/no-plates rule at the point of contribution.

## Lawful-basis quick reference

GDPR: Art. 6(1)(b) account operation · 6(1)(f) legitimate interest for integrity/audit logs
(balanced: IP needed for abuse defense, 2-year cap, access-controlled) · 6(1)(a) consent for
research contact. CCPA: no sale/share of personal information; deletion and access rights wired
as above.
