require("dotenv").config();
const { createClient } = require("@clickhouse/client");

const ch = createClient({
    url: process.env.CLICKHOUSE_HOST,
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
});

async function check() {
    try {
        console.log("Connecting to ClickHouse database...");
        
        // 1. Get breakdown of status
        const statusResult = await ch.query({
            query: `
                SELECT 
                    status, 
                    count() as count 
                FROM telemetry.dirty_windows 
                GROUP BY status
            `,
            format: "JSONEachRow"
        });
        const statusSummary = await statusResult.json();
        console.log("\n--- Dirty Windows Summary ---");
        console.table(statusSummary);

        // 2. Get the latest 10 records
        const latestResult = await ch.query({
            query: `
                SELECT 
                    deviceId, 
                    windowStart, 
                    status, 
                    version, 
                    createdAt
                FROM telemetry.dirty_windows
                ORDER BY version DESC
                LIMIT 10
            `,
            format: "JSONEachRow"
        });
        const latestWindows = await latestResult.json();
        console.log("\n--- Latest 10 Windows (Most Recent Version) ---");
        console.table(latestWindows);

    } catch (err) {
        console.error("Error checking dirty windows:", err);
    } finally {
        await ch.close();
    }
}

check();
