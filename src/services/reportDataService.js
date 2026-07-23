/**
 * Retrieves the latest 15-minute analytics for a device and shapes them for
 * report generation. It keeps reporting read-only and reuses the analytics
 * table's argMax versioning convention so superseded window calculations are
 * never presented to the LLM or document generator.
 */

const clickhouse = require("../config/clickhouse");
const { isBefore } = require("../utils/dateTime");

function asNumber(value) {
    return Number(value || 0);
}

function round(value, precision = 2) {
    return Number(asNumber(value).toFixed(precision));
}

function normalizeWindow(row) {
    return {
        windowStart: row.windowStart,
        windowEnd: row.windowEnd,
        avgSpeed: round(row.avgSpeed),
        maxSpeed: round(row.maxSpeed),
        sampleCount: asNumber(row.sampleCount),
        distanceKm: round(row.distanceWithinWindow, 3),
        engineRunMinutes: round(asNumber(row.engineOnDuration) / 60),
        idleMinutes: round(asNumber(row.idlingDuration) / 60),
        stops: asNumber(row.stopCount),
        stopMinutes: round(asNumber(row.stopDuration) / 60),
        movementMinutes: round(asNumber(row.movementDuration) / 60),
        powerOffMinutes: round(asNumber(row.powerOffDuration) / 60)
    };
}

function buildTotals(windows) {
    const totals = windows.reduce((summary, window) => {
        summary.distanceKm += window.distanceKm;
        summary.engineRunMinutes += window.engineRunMinutes;
        summary.idleMinutes += window.idleMinutes;
        summary.stops += window.stops;
        summary.sampleCount += window.sampleCount;
        summary.speedSum += window.avgSpeed * window.sampleCount;
        summary.maxSpeed = Math.max(summary.maxSpeed, window.maxSpeed);
        return summary;
    }, {
        distanceKm: 0,
        engineRunMinutes: 0,
        idleMinutes: 0,
        stops: 0,
        sampleCount: 0,
        speedSum: 0,
        maxSpeed: 0
    });

    return {
        distanceKm: round(totals.distanceKm, 3),
        engineRunMinutes: round(totals.engineRunMinutes),
        idleMinutes: round(totals.idleMinutes),
        stops: totals.stops,
        avgSpeed: totals.sampleCount > 0
            ? round(totals.speedSum / totals.sampleCount)
            : 0,
        maxSpeed: round(totals.maxSpeed),
        sampleCount: totals.sampleCount
    };
}

async function getDeviceMetricsForRange(deviceId, from, to) {
    if (!deviceId || typeof deviceId !== "string") {
        throw new Error("deviceId is required");
    }

    if (!from || !to) {
        throw new Error("from and to are required");
    }

    if (!isBefore(from, to)) {
        throw new Error("from must be before to");
    }

    const result = await clickhouse.query({
        query: `
            SELECT *
            FROM (
                SELECT
                    deviceId,
                    windowStart,
                    argMax(windowEnd, updatedAt) AS windowEnd,
                    argMax(avgSpeed, updatedAt) AS avgSpeed,
                    argMax(maxSpeed, updatedAt) AS maxSpeed,
                    argMax(sampleCount, updatedAt) AS sampleCount,
                    argMax(distanceWithinWindow, updatedAt) AS distanceWithinWindow,
                    argMax(engineOnDuration, updatedAt) AS engineOnDuration,
                    argMax(idlingDuration, updatedAt) AS idlingDuration,
                    argMax(stopDuration, updatedAt) AS stopDuration,
                    argMax(stopCount, updatedAt) AS stopCount,
                    argMax(movementDuration, updatedAt) AS movementDuration,
                    argMax(powerOffDuration, updatedAt) AS powerOffDuration
                FROM telemetry.analytics_15m
                WHERE deviceId = {deviceId:String}
                GROUP BY deviceId, windowStart
            )
            WHERE windowEnd > parseDateTime64BestEffort({from:String}, 3)
              AND windowStart < parseDateTime64BestEffort({to:String}, 3)
            ORDER BY windowStart
        `,
        query_params: { deviceId, from, to },
        format: "JSONEachRow"
    });

    const windows = (await result.json()).map(normalizeWindow);

    return {
        deviceId,
        reportPeriod: { from, to },
        windows,
        totals: buildTotals(windows)
    };
}

module.exports = { getDeviceMetricsForRange };
