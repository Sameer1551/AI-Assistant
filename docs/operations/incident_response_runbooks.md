# Incident Response and On-Call Runbooks
# Satisfies Requirements 33.1–33.5

This document defines incident severity levels, escalation hierarchies, postmortem SLA targets, and runbooks for alertable conditions.

---

## 1. Incident Severity Matrix & SLAs

| Severity | Description | Target Response Time | Target Resolution SLA | Notification Obligations |
| --- | --- | --- | --- | --- |
| **SEV1 - Critical** | Core service down for all tenants; data leakage or active compromise detected. | **15 Minutes** | **4 Hours** | Inform Executive Sponsors within 1 hour; notify affected customers within 24 hours. |
| **SEV2 - High** | Service degraded for multiple tenants; backup system down. | **30 Minutes** | **8 Hours** | Notify affected customers within 48 hours. |
| **SEV3 - Medium** | Non-critical service down; single tenant minor degradation. | **4 Hours** | **48 Hours** | Status portal update. |
| **SEV4 - Low** | Minor UI bugs; cosmetic issues. | **24 Hours** | **7 Days** | Internal tracker only. |

---

## 2. On-Call Escalation Path
1. **L1 Support**: Paged immediately upon metric threshold breach (alert triggered).
2. **L2 Engineering**: Paged if L1 Support does not acknowledge within **15 minutes**.
3. **Operations Director**: Paged if L2 Engineering does not resolve within **1 hour** for SEV1.

---

## 3. Operations Runbook: Memory Service High-Latency Alert

### Alert Condition
- **Metric**: `memory_query_latency_ms` > 1500ms for consecutive 3-minute window.
- **Symptom**: User experience feels lagging; context assembly times exceed SLO thresholds.

### Diagnostic Steps
1. Query active connections to the vector database:
```bash
docker compose exec redis-service redis-cli client list
```
2. Verify system CPU and Memory levels of host instances:
```bash
top -b -n 1
```

### Mitigation Options
1. **Hysteresis Throttle**: Transition platform resource governor to `REDUCED` or `MINIMAL` to restrict non-critical background jobs.
2. **Horizontal Scaling**: Provision additional replica nodes.
3. **Re-index**: Re-build spatial vector indices during low-traffic windows.

### Verification
- Confirm `memory_query_latency_ms` drops below the normal 300ms SLA target.
- Verify status returns to `nominal` inside telemetry boards.

---

## 4. Postmortem Process
For all SEV1 and SEV2 incidents, a formal postmortem report must be completed and logged **within 7 days** of incident resolution. All root-cause items and corrective actions are tracked to closure with weekly engineering progress reviews.
