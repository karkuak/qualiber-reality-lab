### TelemetryTest AI — Deterministic telemetry rule violation detected

| Field | Value |
| --- | --- |
| Rule | `erl2_ext_journey` |
| Journey | `erl2_ext_journey` |
| Test | `adapters/erl2-subject::erl2_ext_journey` |
| Mode | observe |
| CI blocking | No |
| Collector health | healthy |

**Findings**

- `medium` **missing_required_event** — `quote_requested_zero`
  - expected: `quote_requested_one → quote_requested_three → quote_requested_zero`
  - observed: `quote_requested_one → quote_requested_three`
  - no eligible occurrence observed

> This result is advisory and is **not** a release signal.