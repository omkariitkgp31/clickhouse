const fs = require("fs");
const path = require("path");
require("dotenv").config();

const PORT = process.env.PORT || 3000;
const BASE_URL = `http://localhost:${PORT}`;

async function main() {
    const args = process.argv.slice(2);
    
    // Parse arguments
    let filePath = "";
    let mode = "chunked"; // default mode: chunked
    let chunkSize = 500;   // default chunk size

    for (const arg of args) {
        if (arg.startsWith("--mode=")) {
            mode = arg.split("=")[1];
        } else if (arg.startsWith("--chunkSize=")) {
            chunkSize = parseInt(arg.split("=")[1], 10);
        } else if (!arg.startsWith("-")) {
            filePath = arg;
        }
    }

    if (!filePath) {
        // Try common filenames
        const defaultFiles = ["parsed.json", "data.json"];
        for (const file of defaultFiles) {
            if (fs.existsSync(file)) {
                filePath = file;
                break;
            }
        }
    }

    let resolvedPath = filePath;
    if (filePath && !fs.existsSync(resolvedPath)) {
        const fallbackPath = path.join(__dirname, filePath);
        if (fs.existsSync(fallbackPath)) {
            resolvedPath = fallbackPath;
        }
    }

    if (!resolvedPath || !fs.existsSync(resolvedPath)) {
        console.error(`Error: Could not find JSON file at "${filePath}" or "${path.join(__dirname, filePath)}".`);
        console.log("\nUsage:");
        console.log("  node scripts/sendTelemetry.js <file-path> [--mode=one-by-one|chunked] [--chunkSize=500]");
        console.log("\nExamples:");
        console.log("  node scripts/sendTelemetry.js scripts/device1.json --mode=one-by-one");
        console.log("  node scripts/sendTelemetry.js parsed.json --mode=chunked --chunkSize=500");
        process.exit(1);
    }
    filePath = resolvedPath;

    console.log(`Reading data from: ${filePath}`);
    let data;
    try {
        const fileContent = fs.readFileSync(filePath, "utf8");
        data = JSON.parse(fileContent);
    } catch (err) {
        console.error(`Error parsing JSON from ${filePath}:`, err.message);
        process.exit(1);
    }

    const packets = Array.isArray(data) ? data : [data];
    console.log(`Total records to send: ${packets.length}`);
    console.log(`Sending in '${mode}' mode...\n`);

    const startTime = Date.now();

    if (mode === "one-by-one") {
        let successCount = 0;
        let failCount = 0;

        for (let i = 0; i < packets.length; i++) {
            const packet = packets[i];
            try {
                const response = await fetch(`${BASE_URL}/telemetry`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(packet),
                });

                if (response.ok) {
                    successCount++;
                } else {
                    const errorText = await response.text();
                    failCount++;
                    console.error(`[Record ${i}] Failed: Status ${response.status} - ${errorText.substring(0, 100)}`);
                }
            } catch (err) {
                failCount++;
                console.error(`[Record ${i}] Request error:`, err.message);
            }

            if ((i + 1) % 100 === 0 || i + 1 === packets.length) {
                console.log(`Progress: ${i + 1}/${packets.length} records processed...`);
            }
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\nCompleted one-by-one transmission:`);
        console.log(`- Success: ${successCount}`);
        console.log(`- Failed: ${failCount}`);
        console.log(`- Time elapsed: ${duration}s`);

    } else if (mode === "chunked") {
        let successCount = 0;
        let failCount = 0;
        let processedCount = 0;

        for (let i = 0; i < packets.length; i += chunkSize) {
            const chunk = packets.slice(i, i + chunkSize);
            try {
                const response = await fetch(`${BASE_URL}/telemetry/bulk`, {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                    },
                    body: JSON.stringify(chunk),
                });

                const result = await response.json();
                if (response.ok || response.status === 207) {
                    successCount += (result.inserted || 0);
                    const chunkFailed = (result.failed || []).length;
                    failCount += chunkFailed;
                    if (chunkFailed > 0) {
                        console.warn(`[Chunk ${i / chunkSize + 1}] Partial success. ${result.inserted} inserted, ${chunkFailed} failed.`);
                    }
                } else {
                    failCount += chunk.length;
                    console.error(`[Chunk ${i / chunkSize + 1}] Bulk request failed: Status ${response.status} - ${JSON.stringify(result)}`);
                }
            } catch (err) {
                failCount += chunk.length;
                console.error(`[Chunk ${i / chunkSize + 1}] Request error:`, err.message);
            }

            processedCount += chunk.length;
            console.log(`Progress: ${processedCount}/${packets.length} records processed...`);
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\nCompleted chunked transmission:`);
        console.log(`- Successfully Ingested: ${successCount}`);
        console.log(`- Failed: ${failCount}`);
        console.log(`- Time elapsed: ${duration}s`);
    } else {
        console.error(`Unknown mode: ${mode}. Use 'one-by-one' or 'chunked'.`);
        process.exit(1);
    }
}

main().catch((err) => {
    console.error("Fatal Error:", err);
    process.exit(1);
});
