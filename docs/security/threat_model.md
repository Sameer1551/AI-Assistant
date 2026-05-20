# Threat Model and Security Hardening Guide
# Satisfies Requirements 20.1, 20.2, 20.5, 20.6

This document defines the platform threat model, mitigations, default-deny network boundaries, and annual security review cadences.

---

## 1. Core Threat Matrix

| Threat Category | Target Scenario | Mitigation Strategy | Responsible Service | Verification Mechanism |
| --- | --- | --- | --- | --- |
| **Malicious End User** | User attempts to execute system-level prompt injection or access restricted files | Strict sandboxed execution boundaries, static/dynamic context gating | `Code_Sandbox_Service` / `LLM_Gateway` | Automated property tests verifying sandbox runtime restrictions |
| **Compromised Workstation** | Sensor recording or local keystroke inputs are intercepted | Encrypted in-memory buffers, 1-second pause speed, zero-persistence on consent revocation | `Edge_Agent_Service` | Fast-check tests validating consent revocation within 5 seconds |
| **Malicious Insider** | Administrator attempts to extract or view another tenant's records | Per-tenant cryptographic isolation keys | `Tenant_Isolation_Service` | Prohibited key decryption verification test |
| **Malicious Model Provider** | Outbound model weights or endpoints act maliciously | Strict egress allowlisting, TLS certificate pinning | `API_Gateway` | Daily connection probes to unapproved targets |
| **Network Attacker** | Man-in-the-middle interception of internal microservice communication | Strict mTLS-only requirements on all inter-service ports | `Service_Mesh` / `Identity` | Port scanners checking for plaintext endpoints |
| **Malicious Dependency** | A popular npm dependency gets compromised with a backdoored payload | daily scans, locked lockfiles with cryptographic SHA-256 integrity pins | `CI_CD_Pipeline` | Automated Trivy scanner blocking PR merges on vulnerability |

---

## 2. Default-Deny Network Egress boundaries
To prevent data exfiltration, the platform enforces a default-deny network policy. Services are only allowed to initiate connections to endpoints explicitly registered in the global platform allowlist.

### Allowed Destinations
- Core LLM APIs (e.g., `api.openai.com`, `api.anthropic.com`)
- Tenant OIDC Issuer Endpoint
- SIEM audit forwarding destination URL (specifically if configured)

---

## 3. Security Assessments & Penetration Testing
A formal penetration testing and red-teaming assessment is scheduled and conducted **every 12 months** by an independent, certified third-party vendor. Scope of assessments includes:
- Multi-tenant boundary isolation validation.
- Keystore encryption and KMS key revocation.
- Sandboxed runtime breakout attempts.
