# ClickHouse Telemetry Platform — with LLM-Powered Report Generation

This document describes the full system: the original high-frequency telemetry
ingestion and analytics pipeline, and the LLM-powered report generation
feature added on top of it. It covers architecture, data flow, the API
surface, environment setup, and how to test everything end to end.

> Looking for the deep architectural writeup of the original ingestion
> pipeline? See [`ARCHITECTURE.md`](./ARCHITECTURE.md). This file focuses on
> the system as a whole plus everything added for LLM report generation.

---

## Table of Contents

1. [Overview](#overview)
2. [Tech Stack](#tech-stack)
3. [Project Structure](#project-structure)
4. [Architecture & Data Flow](#architecture--data-flow)
5. [LLM Report Generation — How It Works](#llm-report-generation--how-it-works)
6. [Environment Variables](#environment-variables)
7. [Getting Started](#getting-started)
8. [API Reference](#api-reference)
9. [Testing](#testing)
10. [Troubleshooting](#troubleshooting)
11. [License](#license)

---

## Overview

This platform ingests high-frequency GPS/telemetry data from tracking
devices, buffers and batches it into ClickHouse, continuously computes
15-minute rolling analytics per device (distance travelled, engine run time,
idle time, stop counts, speed), and exposes that data through query APIs.

On top of that existing pipeline, this platform now also generates
**human-readable analytical reports on demand**: given a device and a time
range, it pulls the aggregated 15-minute metrics, sends them to an LLM (Groq)
to produce a structured analysis (summary, insights, anomalies,
recommendations), and renders the result as a polished **DOCX or PDF**
document via a Python script.

## Tech Stack

| Layer | Technology |
|---|---|
| API server | Node.js + Express |
| Database | ClickHouse (MergeTree / ReplacingMergeTree tables) |
| Background processing | Interval-based schedulers (batch insert, analytics, cleanup jobs) |
| LLM provider | [Groq](https://console.groq.com) (OpenAI-compatible Chat Completions API, JSON mode / structured outputs) |
| LLM SDK | `groq-sdk` (Node) |
| Schema validation | `zod` (Node) |
| Report rendering | Python 3.10+, `python-docx` (DOCX), `reportlab` (PDF) |
| Testing | Node scripts (`scripts/test*.js`), `pytest` (Python) |

## Project Structure

```
clickhouse/
├── ARCHITECTURE.md
├── README.md
├── README_ADDED_LLM.md            ← this file
├── package.json
├── .env.example
├── src/
│   ├── server.js
│   ├── config/
│   │   ├── clickhouse.js
│   │   └── groq.js                 (NEW) Groq client singleton
│   ├── controllers/
│   │   ├── telemetryController.js
│   │   ├── analyticController.js
│   │   └── reportController.js     (NEW) POST /reports/generate handler
│   ├── routes/
│   │   ├── telemetry.js
│   │   ├── analytics.js
│   │   └── report.js               (NEW)
│   ├── services/
│   │   ├── telemetryService.js
│   │   ├── bufferService.js
│   │   ├── analyticService.js
│   │   ├── dirtyAnalyticsService.js
│   │   ├── reportDataService.js    (NEW) pulls & shapes 15m metrics from ClickHouse
│   │   ├── llmReportService.js     (NEW) builds prompt, calls Groq, validates JSON
│   │   └── reportService.js        (NEW) orchestrates data → LLM → Python → file
│   ├── jobs/
│   │   ├── batchInsert.job.js
│   │   ├── analytics.job.js
│   │   └── dirtyWindowCleanup.job.js
│   └── utils/
│       ├── coerce.js
│       ├── dateTime.js
│       └── haversine.js
├── scripts/
│   ├── setupDb.js
│   ├── checkTables.js
│   ├── sendTelemetry.js
│   ├── device1.json / device2.json / device3.json
│   ├── testReportData.js            ⚠ testing_llm branch only
│   ├── testLlmCall.js               ⚠ testing_llm branch only
│   └── testGenerateReportEndpoint.js ⚠ testing_llm branch only
├── report-generator/                (NEW) standalone Python subproject
│   ├── generate_report.py
│   ├── requirements.txt
│   ├── sample_data/
│   │   └── sample_report_input.json  ⚠ testing_llm branch only
│   └── test_generate_report.py       ⚠ testing_llm branch only
├── reports/                          (NEW, git-ignored) generated docx/pdf + tmp JSON
└── TESTING.md                        ⚠ testing_llm branch only
```

Items marked ⚠ are not on `main` yet — see [Testing](#testing) for how to
pull them from the `testing_llm` branch.

---

## Architecture & Data Flow

### Original ingestion + analytics pipeline

```
Tracking Devices / GPS Units
        │  HTTP POST /telemetry
        ▼
Telemetry Ingestion API  →  validate & normalize  →  in-memory buffer (queue)
                                                              │
                                    ┌─────────────────────────┴────────────────────────┐
                                    ▼                                                    │
                    Batch Insert Job (every BATCH_INTERVAL_SEC)                          │
                    reads buffer → inserts into ClickHouse `raw_telemetry`                │
                    → registers affected 15-min windows as "dirty"                        │
                                    │                                                     │
                                    ▼                                                     │
                    `dirty_windows_log` (MergeTree) — tracks windows needing recalculation │
                                    │                                                     │
                                    ▼                                                     │
                    Analytics Job (every ANALYTICS_INTERVAL_SEC)                          │
                    fetches pending dirty windows → reads raw data for each window        │
                    → computes distance, engine run time, idle time, stop count, speed     │
                    → upserts into `telemetry_analytics_15m` (ReplacingMergeTree)          │
                    → marks windows completed                                              │
                                    │                                                     │
                    Dirty Window Cleanup Job (every CLEANUP_INTERVAL_SEC)                   │
                    deletes completed dirty-window log entries older than 1 day  ◀──────────┘
                                    │
                                    ▼
                    Analytics Query API — GET /analytics
                    (filters, grouping, pagination over telemetry_analytics_15m)
```

ClickHouse tables:

| Table | Engine | Purpose |
|---|---|---|
| `raw_telemetry` | MergeTree | Every raw telemetry packet as received |
| `telemetry_analytics_15m` | ReplacingMergeTree | Aggregated metrics per device per 15-minute window |
| `dirty_windows_log` | MergeTree | Tracks which windows still need (re)calculation |

### What was added: report generation

The report generator sits **downstream** of `telemetry_analytics_15m` — it
never touches raw telemetry directly and never interferes with ingestion,
buffering, batching, or the dirty-window recalculation loop. It is a purely
additive, on-demand feature triggered by an API call, not a background job.

---

## LLM Report Generation — How It Works

```
Client
  │  POST /reports/generate  { deviceId, from, to, format }
  ▼
reportController.js  — validates request body
  ▼
reportService.js  — orchestrator
  │
  ├─▶ reportDataService.js
  │     queries `telemetry_analytics_15m` for the device/range
  │     returns { deviceId, reportPeriod, windows[], totals }
  │
  ├─▶ llmReportService.js
  │     builds a system + user prompt embedding the metrics above
  │     calls Groq (JSON mode / structured outputs, low temperature)
  │     validates the response against a zod schema; retries once on
  │     invalid/malformed JSON
  │     returns { reportTitle, executiveSummary, keyMetrics, insights,
  │               anomalies, recommendations, notableWindows, ... }
  │
  ├─▶ merges both results into one combined JSON object and writes it to
  │     reports/tmp/<uuid>.json
  │
  └─▶ spawns:  python report-generator/generate_report.py
                 --input reports/tmp/<uuid>.json
                 --output reports/<uuid>.docx   (or .pdf)
                 --format docx | pdf
       │
       ▼
  generate_report.py (python-docx / reportlab)
       builds: title & period → executive summary → key metrics table
       → insights → anomalies (colour-coded by severity: low/medium/high)
       → recommendations → notable windows → full window-by-window detail
       table (raw, deterministic numbers — never LLM-generated)
       │
       ▼
  reportService.js returns { documentPath } to the client — HTTP 201
```

### Why the LLM only sees aggregated data

The LLM is given the already-computed 15-minute metrics, never raw GPS
points. This keeps prompts small and cheap, and keeps anything
safety/precision-critical (the actual distance/speed/stop numbers in the
final report table) coming from deterministic ClickHouse aggregation rather
than model output. The LLM's job is narrative analysis — summary, insights,
anomaly flags, recommendations — not arithmetic.

### Why the LLM's output must be validated JSON, not free text

`llmReportService.js` requests structured JSON output (Groq's JSON mode, or
strict JSON-Schema mode on models that support it) and validates the result
against a fixed schema before it's ever handed to the Python renderer. If the
model returns something invalid, the service retries once with an explicit
correction message before failing loudly — the Python script should never
have to guess at a malformed shape.

### Why report rendering is a separate Python process, not inline JS

Document generation (DOCX/PDF) is handled by a small, independent Python
script that takes **only a JSON file** as input. This keeps it:
- Testable on its own, with no ClickHouse or Groq dependency for its tests.
- Swappable — the rendering approach can change without touching the
  Node.js orchestration or the LLM prompt logic.
- Safe — `reportService.js` invokes it via `execFile` (not a shell string),
  so there's no shell-injection surface from user-controlled input.

---

## Environment Variables

Existing variables (already required by the ingestion/analytics pipeline —
see `.env.example` for full details, including ClickHouse connection
settings) plus the ones added for this feature:

| Variable | Purpose | Example |
|---|---|---|
| `BATCH_INTERVAL_SEC` | How often the batch insert job flushes the buffer | `10` |
| `ANALYTICS_INTERVAL_SEC` | How often the analytics job processes dirty windows | `30` |
| `CLEANUP_INTERVAL_SEC` | How often the dirty-window log is cleaned up | `3600` |
| `GROQ_API_KEY` **(new)** | Your Groq API key ([console.groq.com](https://console.groq.com), free) | `gsk_...` |
| `GROQ_MODEL` **(new)** | Groq model used for report insight generation | `llama-3.3-70b-versatile` |
| `REPORTS_OUTPUT_DIR` **(new)** | Where generated reports and temp JSON payloads are written | `./reports` |
| `PYTHON_BIN` **(new)** | Path to the Python interpreter that has `report-generator/requirements.txt` installed | `.venv/Scripts/python.exe` (Windows) / `.venv/bin/python` (Unix) |

`GROQ_API_KEY` is a secret — never commit a real value. `.env.example`
should only ever contain blank placeholders.

---

## Getting Started

```powershell
# 1. Start ClickHouse and create tables
npm run db:setup

# 2. Install Node.js dependencies
npm install

# 3. Set up the Python report-generator environment
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r report-generator\requirements.txt

# 4. Configure .env (copy from .env.example) with ClickHouse settings plus:
#    GROQ_API_KEY, GROQ_MODEL, REPORTS_OUTPUT_DIR, PYTHON_BIN

# 5. Start the API
npm start
```

---

## API Reference

### `POST /telemetry`
Ingests a single telemetry packet from a device into the in-memory buffer.

### `GET /telemetry/buffer-status`
Returns current in-memory buffer size/status.

### `GET /analytics`
Query aggregated 15-minute analytics with filters, grouping, and pagination.

### `POST /reports/generate` (new)

Generates an LLM-analyzed report for a device over a time range.

**Request body**
```json
{
  "deviceId": "device1",
  "from": "2026-07-01T08:00:00.000Z",
  "to": "2026-07-01T18:00:00.000Z",
  "format": "docx"
}
```
`format` is `"docx"` (default) or `"pdf"`.

**Success response — `201 Created`**
```json
{
  "success": true,
  "data": {
    "documentPath": "reports/6f2c1e2a-....docx"
  }
}
```

**Validation error — `400 Bad Request`**
```json
{
  "success": false,
  "error": "deviceId, from, and to are required, and from must be before to"
}
```

**Server/generation error — `500 Internal Server Error`**
Returned if the ClickHouse query, the Groq call, or the Python rendering
step fails after retries. The error message reflects which stage failed.

---

## Testing

> **Note:** the automated test scripts, the Python test fixture, and the
> full manual QA guide are **not yet merged into `main`**. They live on the
> `testing_llm` branch:
> **https://github.com/omkariitkgp31/clickhouse/tree/testing_llm**

### Pulling the test files

Either check out the branch directly:
```powershell
git fetch origin testing_llm
git checkout testing_llm
```
or pull just the test files into your current branch without switching:
```powershell
git checkout origin/testing_llm -- `
  scripts/testReportData.js `
  scripts/testLlmCall.js `
  scripts/testGenerateReportEndpoint.js `
  report-generator/test_generate_report.py `
  report-generator/sample_data/sample_report_input.json `
  TESTING.md
```

### Running the checks

Once the test files are present, from the repository root, in order:

**1. Verify ClickHouse report data**
```powershell
node scripts/testReportData.js
```
Requires at least one calculated 15-minute window already in
`telemetry_analytics_15m`. Expected: `Report data verification passed`.

**2. Verify the live Groq structured response**
```powershell
node scripts/testLlmCall.js
```
Makes a real call using your configured `GROQ_API_KEY`. Expected:
`Groq LLM verification passed`.

**3. Verify the standalone document generator**
```powershell
.\.venv\Scripts\python.exe report-generator\generate_report.py `
  --input report-generator\sample_data\sample_report_input.json `
  --output reports\sample_report.docx `
  --format docx

.\.venv\Scripts\python.exe report-generator\generate_report.py `
  --input report-generator\sample_data\sample_report_input.json `
  --output reports\sample_report.pdf `
  --format pdf
```
Expected: both commands print `Generated ... report` and produce non-empty
files under `reports/`.

**4. Run the document regression test**
```powershell
.\.venv\Scripts\python.exe -m pytest report-generator\test_generate_report.py
```
Expected: one passing test verifying the DOCX structure (headings, tables).

**5. Verify the complete HTTP workflow**
```powershell
node scripts/testGenerateReportEndpoint.js
```
Spins up an isolated API instance, exercises ClickHouse → Groq → Python
end to end, and checks that invalid input returns `400`. Expected:
`Report endpoint verification passed`, plus the generated document path.

### Manual endpoint check

```powershell
$request = @{
  deviceId = "your-device-id"
  from = "2026-07-01T08:00:00.000Z"
  to = "2026-07-01T18:00:00.000Z"
  format = "docx"
} | ConvertTo-Json

Invoke-RestMethod http://localhost:3000/reports/generate `
  -Method Post `
  -ContentType "application/json" `
  -Body $request
```
Expect `201` with `data.documentPath`. Open the file and check: title,
executive summary, key metrics, severity-coloured anomalies,
recommendations, and the 15-minute detail table.

### Invalid-request check

```powershell
Invoke-WebRequest http://localhost:3000/reports/generate `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"deviceId":"","from":"","to":""}'
```
Must return `400`, not crash the server. A range where `from` is after `to`
must also return `400`.

---

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| `No analytics_15m data is available` | Ingest sample telemetry and wait for the batch + analytics jobs to run before rerunning the data test |
| `GROQ_API_KEY is required` | Add a valid key to `.env` and restart the API |
| `Unable to start Python report generator` | Set `PYTHON_BIN` to the interpreter inside the venv where `report-generator/requirements.txt` was installed |
| `Unable to generate report` | Check server logs — Python writes a specific stderr message for missing/malformed report JSON |

---

## License

Add your project's license here (e.g. MIT, proprietary/internal-use-only).
No license has been finalized in this document — update before publishing
this README externally.
