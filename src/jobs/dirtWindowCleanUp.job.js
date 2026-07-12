const clickhouse =
    require("../config/clickhouse");

const CLEANUP_INTERVAL =
    24 * 60 * 60 * 1000;

let isCleaning = false;

async function cleanup(options = {}) {

    if (isCleaning) {
        return;
    }

    isCleaning = true;

    const dryRun = options.dryRun !== undefined ? options.dryRun : (process.env.CLEANUP_DRY_RUN === 'true');

    try {
        const result = await clickhouse.query({
            query: `
                SELECT
                    deviceId,
                    windowStart
                FROM telemetry.dirty_windows
                GROUP BY
                    deviceId,
                    windowStart
                HAVING argMax(status, version) = 'done'
                   AND argMax(processedAt, version) < now64(3) - INTERVAL 1 DAY
            `,
            format: "JSONEachRow"
        });

        const keysToDelete = await result.json();

        // Use Set of composite keys to deduplicate as required
        const uniqueKeys = new Set(keysToDelete.map(k => `${k.deviceId}::${k.windowStart}`));

        console.log(
            `[Cleanup] Found ${uniqueKeys.size} unique windows to clean up (total candidate rows from query: ${keysToDelete.length})`
        );

        if (uniqueKeys.size === 0) {
            console.log("[Cleanup] No old processed windows to clean up");
            return;
        }

        if (dryRun) {
            console.log("[Cleanup] Dry-run enabled. Skipping deletion.");
            if (uniqueKeys.size > 0) {
                console.log("[Cleanup] Sample of windows that would be deleted:", Array.from(uniqueKeys).slice(0, 10));
            }
            return;
        }

        const uniquePairs = Array.from(uniqueKeys).map(k => {
            const [deviceId, windowStart] = k.split("::");
            const escapedDeviceId = deviceId.replace(/'/g, "\\'");
            return `('${escapedDeviceId}', '${windowStart}')`;
        });

        const BATCH_SIZE = 1000;
        for (let i = 0; i < uniquePairs.length; i += BATCH_SIZE) {
            const batch = uniquePairs.slice(i, i + BATCH_SIZE);
            const inClause = batch.join(", ");
            await clickhouse.command({
                query: `
                    ALTER TABLE telemetry.dirty_windows
                    DELETE WHERE (deviceId, windowStart) IN (${inClause})
                `
            });
        }

        console.log(
            `[Cleanup] Successfully removed ${uniquePairs.length} processed windows`
        );

    } catch (err) {

        console.error(
            "[Cleanup] Failed:",
            err
        );
    } finally {
        isCleaning = false;
    }
}

setInterval(
    cleanup,
    CLEANUP_INTERVAL
);//func call every 24 hours

module.exports = {
    cleanup
};
