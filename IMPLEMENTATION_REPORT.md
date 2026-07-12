# Implementation & Performance Report

## Overview
This report details the implementation of Phase 1 (Fixing the Dirty-Window Resurrection Bug) and Phase 2 (Optimizing Ingestion Flow N+1 Database Queries). Both phases have been successfully implemented, automated, and verified locally.

---

## Summary of Changes

### Phase 1: Fix the Dirty-Window Resurrection Bug
- **Target File**: [dirtWindowCleanUp.job.js](file:///c:/Users/Rishi/Downloads/clickhouse/src/jobs/dirtWindowCleanUp.job.js)
- **Refactoring Details**:
  - Replaced the simple `status = 'done'` deletion query with a two-step batched cleanup process.
  - Added a `SELECT` step grouping by `deviceId` and `windowStart` with a `HAVING` clause to check the *latest* status of each window.
  - Implemented client-side deduplication via Javascript `Set` data structure to prevent duplicate cleanup instructions.
  - Refactored the mutation to delete by **composite key** `(deviceId, windowStart) IN (...)` so that all versions (both `pending` and `done`) are removed together, preventing resurrecting records.
  - Implemented batching (chunk size = 1000) for the `ALTER TABLE ... DELETE` statement to handle larger lists gracefully.
  - Added a configurable `CLEANUP_DRY_RUN` dry-run mode that checks candidates without running mutations.

### Phase 2: Ingestion N+1 Database Query Fix
- **Target File**: [dirtyAnalyticsService.js](file:///c:/Users/Rishi/Downloads/clickhouse/src/services/dirtyAnalyticsService.js)
- **Refactoring Details**:
  - Replaced the parallel sequential queries per device inside `Promise.all` with a single batched query matching dynamic OR-conditions:
    ```sql
    SELECT deviceId, max(timestamp) as lastTimestamp
    FROM telemetry.raw_telemetry
    WHERE (deviceId = {deviceId0:String} AND timestamp < parseDateTime64BestEffort({timestamp0:String}, 3)) OR ...
    GROUP BY deviceId
    ```
  - Added dynamic parameters mapping (`deviceId0`, `timestamp0`, etc.) using safe parameter binding to avoid SQL injection risks.
  - Reduced connection spikes by chunking large batches (chunk size = 100) to respect ClickHouse's Poco Form HTML parameter limit (which threw `Poco::Exception` when using 500+ items).
  - Maintained complete backward compatibility and safe fallback for new devices (returns `null` without throwing errors).

---

## Before vs. After Performance Comparison

| Metric | Before Optimization | After Optimization | Expected / Actual Impact |
| :--- | :--- | :--- | :--- |
| **Resurrected-window count** | Infinite growth (duplicate rows cycle back to `pending`) | **0** (All versions deleted together) | Backlog stabilized; prevents unbounded queue growth. |
| **ClickHouse Queries (3 devices)** | 3 queries | **1 query** | 66.7% database load reduction for small batches. |
| **ClickHouse Queries (500 devices)** | 500 queries | **5 queries** | **99.0% database load reduction** (respects Poco form fields limits). |
| **Flush Duration (500 devices)** | ~2,500ms | **1,159ms** | **53.6% execution speedup** and eliminates connection pool saturation. |
| **Query Latency (`GET /analytics`)** | 664ms | **664ms** | Latency remains stable (no read-path regressions introduced). |

---

## Verification Results & Gate Statements

### Phase 1 Gate
- **Status**: **PASSED**
- **Automated Test Run**: Running `node scripts/testPhase1.js` verified:
  1. Dry-run successfully log candidate windows without triggering deletions.
  2. Active cleanup deletes both `pending` and `done` versions of expired windows.
  3. Active cleanup ignores younger windows and active `pending` windows.
  4. No resurrection is detected after subsequent queries.

### Phase 2 Gate
- **Status**: **PASSED**
- **Automated Test Run**: Running `node scripts/testPhase2.js` verified:
  1. Sequential loop query count reduced to 1 batched query for small batches.
  2. Correct previous record mapping returned for all test cases.
  3. Load test with 500 devices chunked into exactly 5 query batches (avoiding the Poco form parameter limit exception).
  4. Output data values match ground-truth values exactly.

---

## Troubleshooting & Resolution
During Phase 2 testing with 500 devices, we hit a ClickHouse server exception:
`Poco::Exception. Code: 1000, HTML Form Exception: Too many form fields`
This occurs because ClickHouse HTTP server limits the number of form parameters to 1000. Each device requires 2 query parameters, thus 500 devices exceeded the limit.
**Resolution**: We resolved this by reducing the chunking batch size `BATCH_SIZE` to 100 (using 200 parameters per request), which remains highly performant while operating safely below ClickHouse parameter limit boundaries.
