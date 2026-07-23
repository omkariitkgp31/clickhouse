<!--
This guide explains how to verify the LLM telemetry report generator end to
end, including environment setup, individual automated checks, and manual API
validation without needing to inspect the implementation source code.
-->

# Telemetry Report Generator Testing Guide

## Prerequisites

1. Start ClickHouse and run the database setup:

   ```powershell
   npm run db:setup
   ```

2. Install Node.js dependencies:

   ```powershell
   npm install
   ```

3. Create a Python virtual environment and install the report dependencies:

   ```powershell
   python -m venv .venv
   .\.venv\Scripts\python.exe -m pip install -r report-generator\requirements.txt
   ```

4. Configure `.env` with valid ClickHouse and Groq values. Point `PYTHON_BIN`
   to the interpreter containing the report dependencies, for example:

   ```dotenv
   GROQ_API_KEY=your_groq_key
   GROQ_MODEL=llama-3.3-70b-versatile
   REPORTS_OUTPUT_DIR=./reports
   PYTHON_BIN=C:\absolute\path\to\clickhouse\.venv\Scripts\python.exe
   ```

5. Start the API in a separate terminal:

   ```powershell
   npm start
   ```

## Automated checks

Run these commands from the repository root in order.

### 1. Verify ClickHouse report data

The analytics table must contain at least one calculated 15-minute window.

```powershell
node scripts/testReportData.js
```

Expected result: `Report data verification passed`.

### 2. Verify the live Groq structured response

This command makes a real request using the configured Groq API key.

```powershell
node scripts/testLlmCall.js
```

Expected result: `Groq LLM verification passed`.

### 3. Verify the standalone document generator

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

Expected result: both commands print `Generated ... report` and create
non-empty files under `reports`.

### 4. Run the document regression test

```powershell
.\.venv\Scripts\python.exe -m pytest report-generator\test_generate_report.py
```

Expected result: one passing test.

### 5. Verify the complete HTTP workflow

The test starts an isolated API server, fetches analytics from ClickHouse,
calls Groq, produces a DOCX, and verifies invalid input returns HTTP 400.

```powershell
node scripts/testGenerateReportEndpoint.js
```

Expected result: `Report endpoint verification passed` and a generated
document path.

## Manual endpoint check

Send a report request for a device and date range that exist in your
`telemetry.analytics_15m` table:

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

Expected response: HTTP 201 with `data.documentPath`. Open that DOCX or PDF
to check the title, executive summary, metrics, severity-coloured anomalies,
recommendations, and 15-minute detail table.

## Invalid-request check

This request must return HTTP 400 rather than crash the server:

```powershell
Invoke-WebRequest http://localhost:3000/reports/generate `
  -Method Post `
  -ContentType "application/json" `
  -Body '{"deviceId":"","from":"","to":""}'
```

Expected response body includes `"success": false` and an invalid-request
error. A range where `from` is after `to` must also return HTTP 400.

## Troubleshooting

- `No analytics_15m data is available`: ingest sample telemetry and wait for
  the batch and analytics workers to finish before rerunning the data test.
- `GROQ_API_KEY is required`: add a valid key to `.env` and restart the API.
- `Unable to start Python report generator`: set `PYTHON_BIN` to the Python
  executable inside the virtual environment where requirements were installed.
- `Unable to generate report`: inspect the server output; Python writes a
  specific stderr message for missing or malformed report JSON.
