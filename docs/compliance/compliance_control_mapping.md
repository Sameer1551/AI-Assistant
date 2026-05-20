# Compliance Control Mapping & Data Protection Impact Assessment (DPIA)
# Satisfies Requirements 28.1–28.5

This document details the platform's compliance controls mapped to SOC 2 / ISO 27001, the Data Protection Impact Assessment (DPIA), and GDPR Article 30 Records of Processing Activities.

---

## 1. Compliance Control Matrix (Requirement 28.1)

| Requirement | Control Description | SOC 2 TSC Map | ISO 27001 Control Map | Evidence Artifact Location |
| --- | --- | --- | --- | --- |
| **Req 13.3** | Per-tenant encryption keys ensure cryptographic boundary separation. | CC6.1, CC6.3 | A.8.24 (Use of Cryptography) | `services/governance/src/tenant-isolation.ts` |
| **Req 23.4** | Sensor consent revocation stops recording and clears buffers within 5s. | CC6.3, CC6.8 | A.8.10 (Information deletion) | `services/edge-agent/__tests__/edge-agent.pbt.test.ts` |
| **Req 27.1** | DSAR Erasure wipes user records completely from all services within SLA. | CC6.3 | A.8.10 (Information deletion) | `services/governance/src/dsar-service.ts` |
| **Req 32.3** | All backups are encrypted using Secrets Service keys. | CC6.3, CC7.1 | A.8.20 (Backup) | `packages/utils/src/backup-restore.ts` |

---

## 2. Data Protection Impact Assessment (DPIA) (Requirement 28.2)

### Assessment Scope: Continuous Ambient Audio Capture & Cognitive State Inference
1. **Necessity and Proportionality**: Capturing ambient environment audio is required solely to support the wake-word ("Hello May") and hands-free control features. Personalization and emotional/fatigue inferences optimize workload suggestions, which are proportionate to reducing cognitive exhaustion in highly demanding office positions.
2. **Identified Risks**:
   - Accidental recording of non-consenting bystanders.
   - Storage of sensitive PII in recording transcripts.
   - Accidental exposure of private cognitive tracking.
3. **Mitigation Controls**:
   - **Local Ingestion Only**: Local wake-word matching occurs entirely on the edge; audio is not sent to the cloud.
   - **Ingress Redaction**: A real-time PII redaction pipeline filters out standard PII patterns immediately at ingress.
   - **Revocation / Kill Switch**: Users can revoke consent instantly, triggering immediate buffer purging.

---

## 3. GDPR Article 30: Records of Processing Activities (RoPA) (Requirement 28.3)

- **Data Controller**: Platform Operator / Customer Tenant.
- **Categories of Data Subjects**: Customer Employees, Contractor Staff, End Users.
- **Categories of Personal Data processed**:
  - Transcription logs and text prompts.
  - Active screen application names and window titles.
  - Cognitive fatigue indicators and stress vectors.
- **Recipient Categories**:
  - Internal Platform database nodes.
  - Approved LLM Providers (via encrypted Gateway endpoints).
- **Retention Schedule**: Kept strictly according to Tenant Retention Policies (nominal default of 30 days).
- **Security Controls**: Default-deny egress allowlisting, TLS 1.3 inter-service encryption, and customer-managed KMS keys.
