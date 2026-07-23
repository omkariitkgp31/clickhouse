/**
 * Starts an isolated API instance and verifies the complete report endpoint
 * against configured ClickHouse, Groq, and the Python document generator.
 */

require("dotenv").config();

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const clickhouse = require("../src/config/clickhouse");

const TEST_PORT = 3101;
const baseUrl = `http://127.0.0.1:${TEST_PORT}`;

function startServer() {
    return spawn("node", ["src/server.js"], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            PORT: String(TEST_PORT),
            ANALYTICS_INTERVAL_MS: "60000"
        },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true
    });
}

async function waitForServer(child) {
    let output = "";
    child.stdout.on("data", chunk => { output += chunk.toString(); });
    child.stderr.on("data", chunk => { output += chunk.toString(); });

    for (let attempt = 0; attempt < 30; attempt++) {
        try {
            const response = await fetch(`${baseUrl}/telemetry/buffer-size`);
            if (response.ok) {
                return;
            }
        } catch {
            // The process may still be starting.
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    throw new Error(`Test server did not start: ${output}`);
}

async function getTestRange() {
    const result = await clickhouse.query({
        query: `
            SELECT deviceId, min(windowStart) AS from, max(windowEnd) AS to
            FROM telemetry.analytics_15m
            GROUP BY deviceId
            ORDER BY to DESC
            LIMIT 1
        `,
        format: "JSONEachRow"
    });
    const rows = await result.json();
    assert.ok(rows.length > 0, "No analytics data is available for endpoint verification");
    return rows[0];
}

async function stopServer(child) {
    if (!child.killed) {
        child.kill();
    }
}

async function main() {
    const range = await getTestRange();
    const server = startServer();

    try {
        await waitForServer(server);
        const response = await fetch(`${baseUrl}/reports/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                deviceId: range.deviceId,
                from: range.from,
                to: range.to,
                format: "docx"
            })
        });
        const body = await response.json();

        assert.equal(response.status, 201, JSON.stringify(body));
        assert.equal(body.success, true);
        assert.equal(body.data.format, "docx");
        assert.ok(body.data.documentPath.endsWith(".docx"));

        const invalidResponse = await fetch(`${baseUrl}/reports/generate`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                deviceId: "",
                from: "",
                to: "",
                format: "docx"
            })
        });
        const invalidBody = await invalidResponse.json();

        assert.equal(invalidResponse.status, 400, JSON.stringify(invalidBody));
        assert.equal(invalidBody.success, false);

        console.log("Report endpoint verification passed");
        console.log(`Document: ${body.data.documentPath}`);
        console.log("Invalid request: returned 400 cleanly");
    } finally {
        await stopServer(server);
        await clickhouse.close();
    }
}

main().catch(error => {
    console.error("Report endpoint verification failed:", error.message);
    process.exitCode = 1;
});
