### TelemetryTest AI — Inconclusive — collector degraded or no eligible telemetry

| Field | Value |
| --- | --- |
| Rule | `erl2_ext_journey` |
| Journey | `erl2_ext_journey` |
| Test | `adapters/erl2-subject::erl2_ext_journey` |
| Mode | observe |
| CI blocking | No |
| Collector health | degraded |

**Findings**

- `warning` **no_telemetry_observed**
  - collector health=degraded; results inconclusive

> This result is advisory and is **not** a release signal.

#### Rollback advisory
- capture coverage degraded (mean 0.00 < 0.8 over last 1 run(s))
