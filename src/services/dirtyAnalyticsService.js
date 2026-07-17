const clickhouse = require("../config/clickhouse");
const {
    FIFTEEN_MINUTES_MS,
    getWindowBounds,
    toDate
} = require("../utils/dateTime");

let versionCounter = 0;

function nextVersion() {//this function generates a unique version number for each dirty window
    return (Date.now() * 1000) + (++versionCounter % 1000);
}

function addDirtyWindow(windows, deviceId, timestamp, createdAt) {

    const window =
        getWindowBounds(timestamp);


    const key =
        `${deviceId}|${window.windowStart}`;

    windows.set(key, {
        deviceId,
        windowStart: window.windowStart,
        windowEnd: window.windowEnd,
        status: "pending",
        version: nextVersion(),
        createdAt,
        processedAt: null
    });
}

function addDirtyWindowRange(
    windows,
    deviceId,
    previousTimestamp,
    currentTimestamp,
    createdAt
) {
    const previousWindow =
        getWindowBounds(previousTimestamp);

    const currentWindow =
        getWindowBounds(currentTimestamp);

    const previousStart =
        toDate(previousWindow.windowStart).getTime();

    const currentStart =
        toDate(currentWindow.windowStart).getTime();


    for (let start = previousStart + FIFTEEN_MINUTES_MS;
        start <= currentStart;
        start += FIFTEEN_MINUTES_MS
    ) {
        addDirtyWindow(
            windows,
            deviceId,
            new Date(start).toISOString(),
            createdAt
        );
    }
}

function groupRecordsByDevice(records) {
    const groups = new Map();

    for (const record of records) {

        if (!record.deviceId || !record.timestamp) {
            continue;
        }

        if (!groups.has(record.deviceId)) {
            groups.set(record.deviceId, []);
        }

        groups.get(record.deviceId).push(record);
    }

    for (const deviceRecords of groups.values()) {
        deviceRecords.sort(
            (a, b) =>
                toDate(a.timestamp) -
                toDate(b.timestamp)
        );
    }

    return groups;
}

async function getPreviousRecords(deviceRecordsByDevice) {
    /**
     * this function retrieves the most recent telemetry record
     * for each device before the first record in the provided 
     * deviceRecordsByDevice map, using a batched query to avoid N+1 database calls.
     */
    const previousRecords = new Map();
    const entries = Array.from(deviceRecordsByDevice.entries());

    if (entries.length === 0) {
        return previousRecords;
    }

    const BATCH_SIZE = 100; // Limit OR-conditions chunk size to avoid exceeding ClickHouse HTTP parameters limit (Poco Form Limit)

    for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        const chunk = entries.slice(i, i + BATCH_SIZE);
        const query_params = {};
        const orConditions = [];

        chunk.forEach(([deviceId, records], index) => {
            const firstTimestamp = records[0].timestamp;
            const devParam = `deviceId${index}`;
            const tsParam = `timestamp${index}`;

            query_params[devParam] = deviceId;
            query_params[tsParam] = firstTimestamp;

            orConditions.push(
                `(deviceId = {${devParam}:String} AND timestamp < parseDateTime64BestEffort({${tsParam}:String}, 3))`
            );
        });

        const result = await clickhouse.query({
            query: `
                SELECT
                    deviceId,
                    max(timestamp) as lastTimestamp
                FROM telemetry.raw_telemetry
                WHERE ${orConditions.join(" OR ")}
                GROUP BY deviceId
            `,
            query_params,
            format: "JSONEachRow"
        });

        const rows = await result.json();
        for (const row of rows) {
            previousRecords.set(row.deviceId, {
                deviceId: row.deviceId,
                timestamp: row.lastTimestamp
            });
        }
    }

    return previousRecords;
}

function buildDirtyWindows(records, previousRecords = new Map()) {

    const windows = new Map();
    const createdAt = new Date().toISOString();

    const recordsByDevice =
        groupRecordsByDevice(records);

    for (const [deviceId, deviceRecords] of recordsByDevice.entries()) {

        let previousTimestamp =
            previousRecords.get(deviceId)?.timestamp || null;

        for (const record of deviceRecords) {

            addDirtyWindow(
                windows,
                deviceId,
                record.timestamp,
                createdAt
            );

            if (previousTimestamp) {
                addDirtyWindowRange(
                    windows,
                    deviceId,
                    previousTimestamp,
                    record.timestamp,
                    createdAt
                );
            }

            previousTimestamp =
                record.timestamp;
        }
    }

    return Array.from(windows.values());
}

async function markDirty(records) {

    const recordsByDevice =
        groupRecordsByDevice(records);

    const previousRecords =
        await getPreviousRecords(recordsByDevice);

    const windows =
        buildDirtyWindows(
            records,
            previousRecords
        );

    if (windows.length === 0) {
        return 0;
    }

    await clickhouse.insert({
        table: "telemetry.dirty_windows",
        values: windows,
        format: "JSONEachRow"
    });

    return windows.length;
}

async function getDirtyWindows(limit = 100) {

    const result = await clickhouse.query({
        query: `
            SELECT
                deviceId,
                windowStart,
                argMax(windowEnd, version) AS windowEnd,
                argMax(status, version) AS status
            FROM telemetry.dirty_windows
            GROUP BY
                deviceId,
                windowStart
            HAVING status = 'pending'
            ORDER BY windowStart
            LIMIT {limit:UInt32}
        `,
        query_params: {
            limit
        },
        format: "JSONEachRow"
    });

    return result.json();
}

async function markProcessed(windows) {

    if (windows.length === 0) {
        return 0;
    }

    const processedAt =
        new Date().toISOString();

    const rows =
        windows.map(window => ({
            deviceId: window.deviceId,
            windowStart: window.windowStart,
            windowEnd: window.windowEnd,
            status: "done",

            version: nextVersion(),

            createdAt: processedAt,
            processedAt
        }));

    await clickhouse.insert({
        table: "telemetry.dirty_windows",
        values: rows,
        format: "JSONEachRow"
    });

    return windows.length;
}

module.exports = {
    getDirtyWindows,
    markDirty,
    markProcessed
};


