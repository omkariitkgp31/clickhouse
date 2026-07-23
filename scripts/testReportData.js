/**
 * Verifies the report data extraction service against the configured
 * ClickHouse instance. It discovers an available device and validates the
 * public report payload shape without writing or changing telemetry data.
 */

require("dotenv").config();

const assert = require("node:assert/strict");
const clickhouse = require("../src/config/clickhouse");
const {
    getDeviceMetricsForRange
} = require("../src/services/reportDataService");

async function main() {
    const deviceResult = await clickhouse.query({
        query: `
            SELECT
                deviceId,
                min(windowStart) AS from,
                max(windowEnd) AS to
            FROM telemetry.analytics_15m
            GROUP BY deviceId
            ORDER BY to DESC
            LIMIT 1
        `,
        format: "JSONEachRow"
    });
    const devices = await deviceResult.json();

    assert.ok(devices.length > 0, "No analytics_15m data is available for verification");

    const [device] = devices;
    const metrics = await getDeviceMetricsForRange(
        device.deviceId,
        device.from,
        device.to
    );

    assert.equal(metrics.deviceId, device.deviceId);
    assert.deepEqual(metrics.reportPeriod, {
        from: device.from,
        to: device.to
    });
    assert.ok(Array.isArray(metrics.windows));
    assert.ok(metrics.windows.length > 0, "Expected at least one report window");

    for (const window of metrics.windows) {
        for (const field of [
            "avgSpeed", "maxSpeed", "sampleCount", "distanceKm",
            "engineRunMinutes", "idleMinutes", "stops"
        ]) {
            assert.equal(typeof window[field], "number", `Window ${field} must be numeric`);
        }
        assert.ok(window.windowStart);
        assert.ok(window.windowEnd);
    }

    for (const field of [
        "distanceKm", "engineRunMinutes", "idleMinutes", "stops",
        "avgSpeed", "maxSpeed", "sampleCount"
    ]) {
        assert.equal(typeof metrics.totals[field], "number", `Total ${field} must be numeric`);
    }

    console.log("Report data verification passed");
    console.log(`Device: ${metrics.deviceId}`);
    console.log(`Windows: ${metrics.windows.length}`);
    console.log("Totals schema: valid");
}

main().catch(error => {
    console.error("Report data verification failed:", error.message);
    process.exitCode = 1;
}).finally(async () => {
    await clickhouse.close();
});
