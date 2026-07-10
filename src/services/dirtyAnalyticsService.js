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
    /**
     * this func adds a dirty window entry to the windows map for 
     * a specific device and timestamp. It calculates the start and 
     * end of the 15-minute window that the timestamp falls into, 
     * constructs a unique key for the window, and stores an object 
     * representing the dirty window in the windows map. The object 
     * includes details such as deviceId, windowStart, windowEnd, status, 
     * version, createdAt, and processedAt.
     */
    const window =
        getWindowBounds(timestamp);/**
         * this func calculates the start and end of the 15-minute window
         that the timestamp falls into, the getWindowBounds function takes a 
         timestamp as input and returns an object containing the windowStart 
         and windowEnd properties, which represent the start and end of the 
         15-minute window that the timestamp falls into. This is used to group
          telemetry records into discrete time windows for processing and analysis.
         */ 

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

   //this is th loop condition,
        //it iterates through the 15-minute windows between 
        //the previous and current timestamps, adding a dirty window
        //entry for each window to the windows map.
      for (   let start = previousStart + FIFTEEN_MINUTES_MS;
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

function groupRecordsByDevice(records) {//this fnc rec the data and gps them by device id, it returns a map
    // where each key is a deviceId and the value is an array of records for 
    // that device, sorted by timestamp.
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
     * deviceRecordsByDevice map.
     * 
     */
    const previousRecords = new Map();//this holds data in form of key val 
    await Promise.all(
        Array.from(deviceRecordsByDevice.entries())
            .map(async ([deviceId, records]) => {
                const firstTimestamp =
                    records[0].timestamp;

                const result =
                    await clickhouse.query({
                        query: `
                            SELECT
                                deviceId,
                                timestamp
                            FROM telemetry.raw_telemetry
                            WHERE deviceId = {deviceId:String}
                              AND timestamp < parseDateTime64BestEffort({timestamp:String}, 3) //this line converts the provided timestamp string into a DateTime64 format with 3 decimal places of precision, which is suitable for comparison with the timestamp column in the ClickHouse database. 
                            ORDER BY timestamp DESC
                            LIMIT 1
                        `,
                        query_params: {
                            deviceId,
                            timestamp: firstTimestamp
                        },
                        format: "JSONEachRow"
                    });

                const rows =
                    await result.json();

                if (rows.length > 0) {
                    previousRecords.set(
                        deviceId,
                        rows[0]
                    );
                }
            })
    );

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
