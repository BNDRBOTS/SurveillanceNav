# STN Security Notes

## Threat model (who attacks a transparency platform)

1. **Data poisoning** — false records to discredit the dataset → provenance engine: source
   verification, explainable confidence, dispute workflow, immutable history, duplicate detection.
2. **Deanonymization of contributors** — data minimization, pseudonyms allowed, GDPR deletion with
   de-attribution, no trackers, audit access logging.
3. **Account takeover** — scrypt (N=2¹⁵,r=8), lockout w/ backoff, TOTP MFA (mandatory for admins),
   refresh rotation with reuse-detection family revocation, session revocation on password change.
4. **Malicious uploads** — type allowlist + magic-byte verification, ClamAV hook + built-in
   heuristics (EICAR, executable magic, Office macros, PDF JS/launch actions), quarantine + human
   review, PII detection (SSN/Luhn cards/phones/emails/DOB).
5. **Service abuse** — per-user+IP sliding-window rate limits (stricter on auth), 1 MB JSON cap,
   depth/array guards against JSON bombs, 50 MB upload cap, bounded export rows.

## Controls checklist

| Control | Implementation |
| --- | --- |
| Transport | TLS 1.3 at the edge (HSTS emitted when `COOKIE_SECURE=true`); same-origin app |
| Headers | CSP (`default-src 'self'`, tiles allowlisted), XFO DENY, nosniff, Referrer-Policy, Permissions-Policy, COOP/CORP |
| CSRF | `SameSite=Strict` cookies + double-submit token on cookie-authenticated endpoints |
| Injection | 100% parameterized SQL; sort keys whitelist-mapped; zod validation on every input; zero-width/control-char stripping |
| XSS | React escaping; no `dangerouslySetInnerHTML`; user content rendered as text; CSV formula-injection defused |
| AuthZ | Global roles + workspace roles, deny-by-default, server-side on every route; suspension bites ≤30 s via status cache invalidation |
| Secrets | Env/secret-manager only; dev secrets generated per-machine with 0600 perms; logs redact credentials |
| Audit | Append-only `audit_logs` (DB-trigger enforced) for logins, changes, exports, permission and settings changes, with IP/UA |
| Storage | Path-traversal guards, namespaced keys, signed 15-min download URLs, quarantine namespace |
| Supply chain | Security core hand-rolled on `node:crypto` (JWT/TOTP/scrypt/SigV4) with RFC test vectors; lockfile committed; CI runs lint+tests on every PR |

## Penetration-test checklist (verified by automated tests where marked ✓)

- [x] ✓ SQLi probes treated as data (`security.test.ts`)
- [x] ✓ JWT alg-confusion (`alg:none`, wrong secret, expiry) rejected
- [x] ✓ Refresh-token replay revokes session family
- [x] ✓ CSRF missing/mismatched token → 403
- [x] ✓ Rate limit returns 429 + Retry-After, never silent drops
- [x] ✓ EICAR upload quarantined; PII upload flagged
- [x] ✓ Cross-user export access denied; tampered/expired signatures rejected
- [x] ✓ Cross-workspace access denied (deny-by-default)
- [x] ✓ Audit log UPDATE/DELETE blocked at the DB layer
- [x] ✓ Stack traces never leak (consistent envelope)
- [x] ✓ Path traversal in storage keys throws
- [ ] External penetration test before public launch (scope: auth, uploads, exports, admin)

## Reporting

Email security@<your-domain> · no logs of report contents beyond triage · 90-day coordinated disclosure.
