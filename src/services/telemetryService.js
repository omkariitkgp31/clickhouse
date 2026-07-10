const bufferService = require("./bufferService");
const clickhouse = require("../config/clickhouse");
const { toBoolean } = require("../utils/coerce");

const DEFAULT_LIMIT = 1000;//no. of packets that can be retrieved at a time, if the client does not specify a limit, it will default to 1000
const MAX_LIMIT = 10000;
//packet is recieved here from the controller and then validated and then buffered in the bufferService
function validateTelemetry(packet) {//checks whetther the incoming packet is valid
    const errors = [];

    if (!packet || typeof packet !== "object") {
        return ["payload must be an object"];
    }

    if (packet.mainPower === undefined) {
        packet.mainPower = false;
    }

    if (!packet.deviceId || typeof packet.deviceId !== "string") {
        errors.push("deviceId is required");
    }

    const lat = Number(packet.lat);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
        errors.push("lat must be between -90 and 90");
    }

    const long = Number(packet.long);
    if (!Number.isFinite(long) || long < -180 || long > 180) {
        errors.push("long must be between -180 and 180");
    }

    const speed = Number(packet.speed);
    if (!Number.isFinite(speed) || speed < 0) {
        errors.push("speed must be a non-negative number");
    }

    const direction = Number(packet.direction);
    if (!Number.isInteger(direction) || direction < 0 || direction > 360) {
        errors.push("direction must be an integer between 0 and 360");
    }

    const ignition = toBoolean(packet.ignition);
    if (ignition === null) {
        errors.push("ignition must be boolean");
    }

    const mainPower = toBoolean(packet.mainPower);
    if (mainPower === null) {
        errors.push("mainPower must be boolean");
    }

    if (!packet.timestamp || Number.isNaN(new Date(packet.timestamp).getTime())) {
        errors.push("timestamp must be a valid date");
    }

    return errors;
}

function ingest(packet) {
    const errors = validateTelemetry(packet);

    if (errors.length > 0) {
        const error = new Error("Invalid telemetry payload");
        error.statusCode = 400;
        error.details = errors;
        throw error;
    }
    //bufferService stores the packet in memory (RAM)
    bufferService.add({//calls add fnc from the bufferService to add this packet into buffer, it converts the values to the correct types and formats before adding them to the buffer.
        deviceId: packet.deviceId,
        lat: Number(packet.lat),
        long: Number(packet.long),
        speed: Number(packet.speed) * 1.852,
        direction: Number(packet.direction),
        ignition: toBoolean(packet.ignition),
        mainPower: toBoolean(packet.mainPower),
        timestamp: new Date(packet.timestamp).toISOString(),
        receivedAt: new Date().toISOString(),
    });
}
//pagination is defined as the process of dividing a large set of data into smaller,
//  more manageable chunks or pages. In this code, the getPagination function is used
// to determine the limit and offset values for pagination based on the provided limit 
// and offset parameters. The limit specifies the maximum number of records to retrieve per 
// page, while the offset indicates the starting point for retrieving records.
//  The function ensures that the limit is within a valid range and returns an object
//  containing the calculated limit and offset values.
function getPagination(limit, offset) {//fnc is used to find the limit and offset values
    const parsedLimit =
        Number(limit);

    const parsedOffset =
        Number(offset);

    return {
        limit:
            Number.isInteger(parsedLimit) && parsedLimit > 0
                ? Math.min(parsedLimit, MAX_LIMIT)
                : DEFAULT_LIMIT,
        offset:
            Number.isInteger(parsedOffset) && parsedOffset > 0
                ? parsedOffset
                : 0
    };
}

//this function if used for reading the daat from clickhouse database, 
// it takes the query parameters from the client and constructs a SQL query 
// to retrieve the telemetry data based on the specified conditions. 
// It uses the clickhouse.query method to execute the query and returns 
// the result in JSON format.
async function getTelemetry(deviceId, from, to, limit, offset) {
    const conditions = [];
    const queryParams = {};
    const pagination =
        getPagination(limit, offset);

    if (deviceId) {
        conditions.push("deviceId = {deviceId:String}");
        queryParams.deviceId = deviceId;
    }

    if (from) {
        conditions.push("timestamp >= parseDateTime64BestEffort({from:String}, 3)");
        queryParams.from = from;
    }

    if (to) {
        conditions.push("timestamp <= parseDateTime64BestEffort({to:String}, 3)");
        queryParams.to = to;
    }

    const whereClause =
        conditions.length > 0
            ? `WHERE ${conditions.join(" AND ")}`
            : "";

    queryParams.limit = pagination.limit;
    queryParams.offset = pagination.offset;

    const result = await clickhouse.query({
        query: `
            SELECT
                deviceId,
                lat,
                long,
                speed,
                direction,
                ignition,
                mainPower,
                timestamp,
                receivedAt
            FROM telemetry.raw_telemetry
            ${whereClause}
            ORDER BY timestamp
            LIMIT {limit:UInt32}
            OFFSET {offset:UInt32}
        `,
        query_params: queryParams,
        format: "JSONEachRow"
    });

    return result.json();
}

/**
 * Ingests an array of raw telemetry packets.
 * Validates each record individually â€” valid ones are buffered,
 * invalid ones are collected and returned to the caller.
 *
 * @param {Array} packets  - Array of raw telemetry objects
 * @returns {{ inserted: number, failed: Array }} summary
 */
function ingestBulk(packets) {
    if (!Array.isArray(packets) || packets.length === 0) {
        const error = new Error("Payload must be a non-empty array");
        error.statusCode = 400;
        throw error;
    }

    const failed = [];
    let inserted = 0;

    for (let i = 0; i < packets.length; i++) {
        const packet = packets[i];
        const errors = validateTelemetry(packet);

        if (errors.length > 0) {
            failed.push({ index: i, errors, packet });
            continue;
        }

        bufferService.add({
            deviceId: packet.deviceId,
            lat: Number(packet.lat),
            long: Number(packet.long),
            speed: Number(packet.speed),
            direction: Number(packet.direction),
            ignition: toBoolean(packet.ignition),
            mainPower: toBoolean(packet.mainPower),
            timestamp: new Date(packet.timestamp).toISOString(),
            receivedAt: new Date().toISOString(),
        });

        inserted++;
    }

    return { inserted, failed };
}

module.exports = {
    ingest,
    ingestBulk,
    getTelemetry,
    validateTelemetry
};
