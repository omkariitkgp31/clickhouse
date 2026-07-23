/**
 * Makes a real Groq request using representative report metrics and confirms
 * that the LLM integration returns the strict structured insight contract.
 */

require("dotenv").config();

const assert = require("node:assert/strict");
const {
    generateReportInsights
} = require("../src/services/llmReportService");

const metrics = {
    deviceId: "test-device-001",
    reportPeriod: {
        from: "2026-06-06T08:00:00.000Z",
        to: "2026-06-06T09:00:00.000Z"
    },
    totals: {
        distanceKm: 42.75,
        engineRunMinutes: 52,
        idleMinutes: 11,
        stops: 2,
        avgSpeed: 46.4,
        maxSpeed: 87.2,
        sampleCount: 240
    },
    windows: [
        {
            windowStart: "2026-06-06T08:00:00.000Z",
            windowEnd: "2026-06-06T08:15:00.000Z",
            avgSpeed: 38.5,
            maxSpeed: 62,
            sampleCount: 60,
            distanceKm: 9.6,
            engineRunMinutes: 13,
            idleMinutes: 2,
            stops: 0
        },
        {
            windowStart: "2026-06-06T08:15:00.000Z",
            windowEnd: "2026-06-06T08:30:00.000Z",
            avgSpeed: 58.2,
            maxSpeed: 87.2,
            sampleCount: 60,
            distanceKm: 14.8,
            engineRunMinutes: 15,
            idleMinutes: 0,
            stops: 0
        }
    ]
};

async function main() {
    const insights = await generateReportInsights(metrics);

    assert.equal(typeof insights.reportTitle, "string");
    assert.ok(insights.executiveSummary.length > 0);
    assert.ok(Array.isArray(insights.insights));
    assert.ok(Array.isArray(insights.anomalies));
    assert.ok(Array.isArray(insights.recommendations));
    assert.ok(Array.isArray(insights.notableWindows));

    console.log("Groq LLM verification passed");
    console.log(`Title: ${insights.reportTitle}`);
    console.log(`Insights: ${insights.insights.length}`);
    console.log(`Anomalies: ${insights.anomalies.length}`);
}

main().catch(error => {
    console.error("Groq LLM verification failed:", error.message);
    process.exitCode = 1;
});
