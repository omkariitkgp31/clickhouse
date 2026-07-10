const clickhouse = require("../config/clickhouse");
const bufferService = require("../services/bufferService");
const dirtyAnalyticsService = require("../services/dirtyAnalyticsService");

const BATCH_SIZE = 5000;
const FLUSH_INTERVAL = 10000;

let isFlushing = false;
/**
 * this flushBufferedTelemetry() is responsible for flushing the buffered
 * telemetry data to ClickHouse in batches. It checks if a flush operation 
 * is already in progress and returns if so. If the buffer is empty, it also returns. 
 * Otherwise, it retrieves a batch of telemetry records from the buffer, inserts 
 * them into ClickHouse, removes them from the buffer, and marks the corresponding 
 * analytics windows as dirty. It logs the progress and any errors encountered during 
 * the process.
 * @returns 
 */ 
async function flushBufferedTelemetry() {//moving the accumulated data from a temporary storage to its final destination, and then clearing the temporary storage.
    if (isFlushing) {
        return;
    }

    isFlushing = true;

    const currentBufferSize = bufferService.getBuffer().length;

    if (currentBufferSize === 0) {
        isFlushing = false;
        return;
    }

    const batch = bufferService.peek(BATCH_SIZE);

    console.log(
        `[Worker] Flushing ${batch.length} records to ClickHouse`
    );

    try {//try: is used in node js to hjndle errors that may occur during the execution of a block of code. It allows you to catch and handle exceptions gracefully, preventing the application from crashing and providing an opportunity to log or respond to errors appropriately.
        await clickhouse.insert({//inserts data into db
            table: "telemetry.raw_telemetry",
            values: batch,
            format: "JSONEachRow",
        });

        bufferService.remove(batch.length);

        console.log(
            `[Worker] Successfully inserted ${batch.length} records`
        );

        const dirtyWindows =
            await dirtyAnalyticsService.markDirty(batch);

        console.log(
            `[Worker] Marked ${dirtyWindows} analytics windows dirty`
        );

        const remaining =
            bufferService.getBuffer().length;

        console.log(
            `[Worker] Remaining in buffer: ${remaining}`
        );

    } catch (err) {//runs the code only if there is an error in the try block, it logs the error message to the console with a prefix indicating that it occurred during the batch insert operation. This helps in identifying and troubleshooting issues related to the insertion of telemetry records into ClickHouse.
        console.error(
            "[Worker] Batch Insert Error:",
            err
        );
    } finally {
        isFlushing = false;
    }

}

setInterval(flushBufferedTelemetry, FLUSH_INTERVAL);//this menas that the flushBufferedTelemetry function will be called every 10 seconds 

module.exports = {
    flushBufferedTelemetry
};
