const analyticsService = require("../services/analyticService");
const dirtyAnalyticsService = require("../services/dirtyAnalyticsService");

const ANALYTICS_INTERVAL = Number(process.env.ANALYTICS_INTERVAL_MS) || 60 * 1000;
const ANALYTICS_BATCH_SIZE = Number(process.env.ANALYTICS_BATCH_SIZE) || 100;
const ANALYTICS_CONCURRENCY = Number(process.env.ANALYTICS_CONCURRENCY) || 5;

let isRunning = false;

async function processDirtyWindows() {
    if (isRunning) {
        return;
    }

    isRunning = true;

    try {
        const windows =
            await dirtyAnalyticsService.getDirtyWindows(ANALYTICS_BATCH_SIZE);

        if (windows.length === 0) {
            return;
        }

        console.log(
            `[Analytics Worker] Processing ${windows.length} dirty windows`
        );

        const processedWindows =
            await processWithConcurrency(
                windows,
                ANALYTICS_CONCURRENCY
            );

        if (processedWindows.length > 0) {
            await dirtyAnalyticsService.markProcessed(processedWindows);
        }

        console.log(
            `[Analytics Worker] Processed ${processedWindows.length} dirty windows`
        );
    } catch (err) {
        console.error("[Analytics Worker] Error:", err);
    } finally {
        isRunning = false;
    }
}

async function processWithConcurrency(windows, concurrency) {
    const processedWindows = [];
    let nextIndex = 0;

    async function worker() {
        while (nextIndex < windows.length) {
            const window = windows[nextIndex];
            nextIndex++;

            try {
                await analyticsService.computeAndStoreWindow(
                    window.deviceId,
                    window.windowStart,
                    window.windowEnd
                );

                processedWindows.push(window);
            } catch (err) {
                console.error(
                    "[Analytics Worker] Window failed:",
                    window,
                    err
                );
            }
        }
    }

    const workers =
        Array.from(
            {
                length:
                    Math.min(concurrency, windows.length)
            },
            () => worker()
        );

    await Promise.all(workers);

    return processedWindows;
}

setInterval(processDirtyWindows, ANALYTICS_INTERVAL);
processDirtyWindows();

module.exports = {
    processDirtyWindows,
};
