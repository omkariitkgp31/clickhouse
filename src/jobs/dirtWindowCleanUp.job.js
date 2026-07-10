const clickhouse =
    require("../config/clickhouse");

const CLEANUP_INTERVAL =
    24 * 60 * 60 * 1000;

let isCleaning = false;

async function cleanup() {

    if (isCleaning) {
        return;
    }

    isCleaning = true;

    try {

        await clickhouse.command({//executes a command on the ClickHouse database
            query: `
                ALTER TABLE telemetry.dirty_windows
                DELETE
                WHERE status = 'done'
                  AND processedAt <
                    now64(3) - INTERVAL 1 DAY
            `/*this query deletes rows from the telemetry.dirty_windows 
            table where the status is 'done' and the processedAt timestamp 
            is older than 1 day from the current time. The now64(3) function
             returns the current timestamp with 3 decimal places of 
             precision, and the INTERVAL 1 DAY subtracts one day from 
             that timestamp. */ 
        });//deletes rows where status is done and processedAt is older than 1 day

        console.log(
            "[Cleanup] Old processed windows removed"
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
