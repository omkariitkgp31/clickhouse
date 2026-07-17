const clickhouse = require("../config/clickhouse");
const haversine = require("../utils/haversine");
const {
    isBefore,
    normalizeUtc,
    toDate
} = require("../utils/dateTime");

const MOVEMENT_THRESHOLD = 1;
const STOP_MIN_DURATION = 180;

function normalizePoint(row) {
    return {
        lat: Number(row.lat),
        long: Number(row.long),
        speed: Number(row.speed),
        ignition: row.ignition === true ||
            row.ignition === 1 ||
            row.ignition === "1",
        timestamp: row.timestamp
    };
}

function getTimestampMs(value) {
    return toDate(value).getTime();
}

function getSegmentDurationSeconds(start, end) {
    return Math.max(
        0,
        (getTimestampMs(end) - getTimestampMs(start)) / 1000
    );
}

function getStopContributionSeconds(
    offStart,
    offEnd,
    windowStart,
    windowEnd
) {
    const totalOffDuration =
        getSegmentDurationSeconds(
            offStart,
            offEnd
        );

    if (totalOffDuration <= STOP_MIN_DURATION) {
        return 0;
    }

    const effectiveStart =
        Math.max(
            getTimestampMs(offStart),
            getTimestampMs(windowStart)
        );

    const effectiveEnd =
        Math.min(
            getTimestampMs(offEnd),
            getTimestampMs(windowEnd)
        );

    const overlapSeconds =
        Math.max(
            0,
            (effectiveEnd - effectiveStart) / 1000
        );

    if (overlapSeconds <= 0) {
        return 0;
    }

    const deductionStart =
        getTimestampMs(offStart) +
        STOP_MIN_DURATION * 1000;

    const effectiveDeduction =
        Math.max(
            effectiveStart,
            deductionStart
        );

    return Math.max(
        0,
        (effectiveEnd - effectiveDeduction) / 1000
    );
}

function calculateIdlingDuration(points, windowEnd) {
    let idleDuration = 0;

    for (let i = 0; i < points.length; i++) {//O(n)
        const current = points[i];
        const next = points[i + 1];

        const segmentEnd =
            next
                ? next.timestamp
                : windowEnd;

        if (
            current.ignition &&
            current.speed <= MOVEMENT_THRESHOLD
        ) {
            idleDuration += getSegmentDurationSeconds(
                current.timestamp,
                segmentEnd
            );
        }
    }

    return idleDuration;
}

function qualifiesAsStop(offStart, offEnd) {
    return getSegmentDurationSeconds(offStart, offEnd) > STOP_MIN_DURATION;
}

function shouldCountStopInWindow(offStart, windowStart, windowEnd) {
    const qualificationTime =
        getTimestampMs(offStart) +
        STOP_MIN_DURATION * 1000;

    return (
        qualificationTime >= getTimestampMs(windowStart) &&
        qualificationTime < getTimestampMs(windowEnd)
    );
}

function calculateStopMetrics(
    points,
    windowStart,
    windowEnd,
    offSessionStart = null
) {
    let stopDuration = 0;
    let stopCount = 0;

    let currentOffStart = offSessionStart;

    for (const point of points) {

        // Vehicle is OFF
        if (!point.ignition) {

            if (!currentOffStart) {
                currentOffStart = point.timestamp;
            }

            continue;
        }

        // Vehicle turned ON after being OFF
        if (currentOffStart) {

            if (qualifiesAsStop(
                currentOffStart,
                point.timestamp
            )) {

                if (shouldCountStopInWindow(
                    currentOffStart,
                    windowStart,
                    windowEnd
                )) {
                    stopCount++;
                }

                stopDuration += getStopContributionSeconds(
                    currentOffStart,
                    point.timestamp,
                    windowStart,
                    windowEnd
                );
            }

            currentOffStart = null;
        }
    }

    // Stop continues beyond this window
    if (currentOffStart) {

        if (qualifiesAsStop(
            currentOffStart,
            windowEnd
        )) {

            if (shouldCountStopInWindow(
                currentOffStart,
                windowStart,
                windowEnd
            )) {
                stopCount++;
            }

            stopDuration += getStopContributionSeconds(
                currentOffStart,
                windowEnd,
                windowStart,
                windowEnd
            );
        }
    }

    return {
        stopCount,
        stopDuration
    };
}

function addStopSessionContribution(
    totals,
    offStart,
    offEnd,
    rangeStart,
    rangeEnd
) {
    if (!qualifiesAsStop(offStart, offEnd)) {
        return;
    }

    const overlapStart =
        Math.max(
            getTimestampMs(offStart),
            getTimestampMs(rangeStart)
        );

    const overlapEnd =
        Math.min(
            getTimestampMs(offEnd),
            getTimestampMs(rangeEnd)
        );

    const overlapSeconds =
        Math.max(
            0,
            (overlapEnd - overlapStart) / 1000
        );

    if (overlapSeconds <= 0) {
        return;
    }

    totals.stopCount++;
    totals.stopDuration += overlapSeconds;
}

function calculateReportStopMetrics(
    rows,
    from,
    to,
    offSessionStart = null
) {
    const totals = {
        stopCount: 0,
        stopDuration: 0
    };

    let currentOffStart =
        offSessionStart;

    for (const row of rows) {
        const point =
            normalizePoint(row);

        if (!point.ignition) {
            if (!currentOffStart) {
                currentOffStart =
                    point.timestamp;
            }

            continue;
        }

        if (currentOffStart) {
            addStopSessionContribution(
                totals,
                currentOffStart,
                point.timestamp,
                from,
                to
            );

            currentOffStart = null;
        }
    }

    if (currentOffStart) {
        addStopSessionContribution(
            totals,
            currentOffStart,
            to,
            from,
            to
        );
    }

    return totals;
}

async function getOffSessionStartBefore(deviceId, timestamp) {
    const [
        previousPointResult,
        offSessionResult
    ] = await Promise.all([
        clickhouse.query({
            query: `
                SELECT
                    ignition,
                    timestamp
                FROM telemetry.raw_telemetry
                WHERE deviceId = {deviceId:String}
                  AND timestamp < parseDateTime64BestEffort({timestamp:String}, 3)
                ORDER BY timestamp DESC
                LIMIT 1
            `,
            query_params: {
                deviceId,
                timestamp
            },
            format: "JSONEachRow"
        }),

        clickhouse.query({
            query: `
                WITH
                    (
                        SELECT max(timestamp)
                        FROM telemetry.raw_telemetry
                        WHERE deviceId = {deviceId:String}
                          AND ignition = 1
                          AND timestamp < parseDateTime64BestEffort({timestamp:String}, 3)
                    ) AS lastOnBeforeBoundary
                SELECT min(timestamp) AS offSessionStart
                FROM telemetry.raw_telemetry
                WHERE deviceId = {deviceId:String}
                  AND ignition = 0
                  AND timestamp < parseDateTime64BestEffort({timestamp:String}, 3)
                  AND timestamp > lastOnBeforeBoundary
            `,
            query_params: {
                deviceId,
                timestamp
            },
            format: "JSONEachRow"
        })
    ]);

    const previousRows =
        await previousPointResult.json();

    const previousPoint =
        previousRows.length > 0
            ? normalizePoint(previousRows[0])
            : null;

    if (!previousPoint || previousPoint.ignition) {
        return null;
    }

    const offSessionRows =
        await offSessionResult.json();

    return offSessionRows.length > 0
        ? offSessionRows[0].offSessionStart
        : previousPoint.timestamp;
}

async function getReportStopMetrics(deviceId, from, to) {
    const [
        rowsResult,
        offSessionStart
    ] = await Promise.all([
        clickhouse.query({
            query: `
                SELECT
                    lat,
                    long,
                    speed,
                    ignition,
                    timestamp
                FROM telemetry.raw_telemetry
                WHERE deviceId = {deviceId:String}
                  AND timestamp >= parseDateTime64BestEffort({from:String}, 3)
                  AND timestamp < parseDateTime64BestEffort({to:String}, 3)
                ORDER BY timestamp
            `,
            query_params: {
                deviceId,
                from,
                to
            },
            format: "JSONEachRow"
        }),

        getOffSessionStartBefore(
            deviceId,
            from
        )
    ]);

    const rows =
        await rowsResult.json();

    return calculateReportStopMetrics(
        rows,
        from,
        to,
        offSessionStart
    );
}

function buildWindowPoints(rows, windowStart, context = {}) {
    const points = [];

    for (const row of rows) {
        const point = {
            ...normalizePoint(row),
            synthetic: false
        };

        const last =
            points[points.length - 1];

        if (
            last &&
            last.timestamp === point.timestamp &&
            last.lat === point.lat &&
            last.long === point.long &&
            last.speed === point.speed &&
            last.ignition === point.ignition
        ) {
            continue;
        }

        if (
            last &&
            getTimestampMs(point.timestamp) < getTimestampMs(last.timestamp)
        ) {
            throw new Error(
                `[Analytics] buildWindowPoints input is out of order: ${point.timestamp} is before ${last.timestamp}`
            );
        }

        points.push(point);
    }

    // points are pre-sorted by ClickHouse ORDER BY timestamp — see computeAndStoreWindow query

    if (!context.previousPoint) {
        return points;
    }

    const previousPoint =
        normalizePoint(context.previousPoint);

    if (
        getTimestampMs(previousPoint.timestamp) >=
        getTimestampMs(windowStart)
    ) {
        return points;
    }

    const syntheticPoint = {
        ...previousPoint,
        timestamp: windowStart,
        synthetic: true
    };

    if (
        points.length === 0 ||
        getTimestampMs(points[0].timestamp) >
        getTimestampMs(windowStart)
    ) {
        points.unshift(syntheticPoint);
    }

    return points;
}



function aggregateWindows(
    deviceId,
    from,
    to,
    windows
) {

    const sortedWindows =
        windows.sort(
            (a, b) =>
                toDate(a.windowStart) -
                toDate(b.windowStart)
        );

    let sampleCount = 0;
    let maxSpeed = 0;
    let totalDistance = 0;
    let powerOffDuration = 0;
    let engineOnDuration = 0;
    let movementDuration = 0;
    let idlingDuration = 0;
    let stopDuration = 0;
    let stopCount = 0;
    let firstIgnitionOn = null;
    let lastIgnitionOff = null;
    let previousPointWindow = null;

    for (const window of sortedWindows) {
        sampleCount += Number(window.sampleCount || 0);
        maxSpeed = Math.max(
            maxSpeed,
            Number(window.maxSpeed || 0)
        );
        totalDistance += Number(window.distanceWithinWindow || 0);
        powerOffDuration += Number(window.powerOffDuration || 0);
        engineOnDuration += Number(window.engineOnDuration || 0);
        movementDuration += Number(window.movementDuration || 0);
        idlingDuration += Number(window.idlingDuration || 0);
        stopDuration += Number(window.stopDuration || 0);
        stopCount += Number(window.stopCount || 0);

        if (!firstIgnitionOn && window.firstIgnitionOn) {
            firstIgnitionOn = window.firstIgnitionOn;
        }

        if (window.lastIgnitionOff) {
            lastIgnitionOff = window.lastIgnitionOff;
        }

        const hasPoint =
            window.firstLat !== null &&
            window.firstLong !== null &&
            window.lastLat !== null &&
            window.lastLong !== null;

        if (!hasPoint) {
            continue;
        }

        if (previousPointWindow) {

            totalDistance += haversine(
                Number(previousPointWindow.lastLat),
                Number(previousPointWindow.lastLong),

                Number(window.firstLat),
                Number(window.firstLong)
            );
        }

        previousPointWindow = window;
    }

    let tripDurationSeconds = 0;

    if (
        firstIgnitionOn &&
        lastIgnitionOff
    ) {
        tripDurationSeconds =
            Math.max(
                0,
                (
                    toDate(lastIgnitionOff) -
                    toDate(firstIgnitionOn)
                ) / 1000
            );
    }

    const avgSpeed =
        tripDurationSeconds > 0
            ? Number(
                (
                    totalDistance /
                    (tripDurationSeconds / 3600)
                ).toFixed(2)
            )
            : 0;


    return {
        deviceId,
        from,
        to,
        coverageFrom:
            sortedWindows.length > 0
                ? sortedWindows[0].windowStart
                : null,

        coverageTo:
            sortedWindows.length > 0
                ? sortedWindows[
                    sortedWindows.length - 1
                ].windowEnd
                : null,

        avgSpeed,

        maxSpeed,

        totalDistance:
            Number(
                totalDistance.toFixed(3)
            ),

        engineOnDuration:
            Math.round(
                engineOnDuration
            ),

        powerOffDuration:
            Math.round(
                powerOffDuration
            ),

        movementDuration:
            Math.round(
                movementDuration
            ),

        idlingDuration:
            Math.round(
                idlingDuration
            ),

        stopDuration:
            Math.round(
                stopDuration
            ),

        stopCount,

        firstIgnitionOn,
        lastIgnitionOff,

        sampleCount
    };
}

async function getAnalytics(filters) {

    const {
        deviceId,
        from,
        to,
        includeWindows
    } = filters;

    if (!deviceId) {
        throw new Error("deviceId is required");
    }

    if (!from || !to) {
        throw new Error("from and to are required");
    }

    if (!isBefore(from, to)) {
        throw new Error("from must be before to");
    }

    const shouldIncludeWindows =
        includeWindows === "true";

    const result = await clickhouse.query({
        query: `
            SELECT *
FROM
(
    SELECT
        deviceId,
        windowStart,
        argMax(windowEnd, updatedAt) AS windowEnd,
        argMax(avgSpeed, updatedAt) AS avgSpeed,
        argMax(maxSpeed, updatedAt) AS maxSpeed,
        argMax(speedSum, updatedAt) AS speedSum,
        argMax(sampleCount, updatedAt) AS sampleCount,
        argMax(totalDistance, updatedAt) AS totalDistance,
        argMax(distanceWithinWindow, updatedAt) AS distanceWithinWindow,
        argMax(powerOffDuration, updatedAt) AS powerOffDuration,
        argMax(engineOnDuration, updatedAt) AS engineOnDuration,
        argMax(movementDuration, updatedAt) AS movementDuration,
        argMax(stopDuration, updatedAt) AS stopDuration,
        argMax(idlingDuration, updatedAt) AS idlingDuration,
        argMax(stopCount, updatedAt) AS stopCount,
        argMax(lastIgnitionOff, updatedAt) AS lastIgnitionOff,
        argMax(firstIgnitionOn, updatedAt) AS firstIgnitionOn,
        argMax(firstLat, updatedAt) AS firstLat,
        argMax(firstLong, updatedAt) AS firstLong,
        argMax(lastLat, updatedAt) AS lastLat,
        argMax(lastLong, updatedAt) AS lastLong,
        argMax(firstTimestamp, updatedAt) AS firstTimestamp,
        argMax(lastTimestamp, updatedAt) AS lastTimestamp,
        argMax(firstIgnition, updatedAt) AS firstIgnition,
        argMax(lastIgnition, updatedAt) AS lastIgnition
    FROM telemetry.analytics_15m
    WHERE deviceId = {deviceId:String}
    GROUP BY
        deviceId,
        windowStart
)
WHERE
    windowEnd > parseDateTime64BestEffort({from:String}, 3)
    AND
    windowStart < parseDateTime64BestEffort({to:String}, 3)
ORDER BY windowStart
        `,
        query_params: {
            deviceId,
            from,
            to
        },
        format: "JSONEachRow"
    });

    const windows = await result.json();

    const summary = aggregateWindows(
        deviceId,
        from,
        to,
        windows
    );

    const reportStopMetrics =
        await getReportStopMetrics(
            deviceId,
            from,
            to
        );

    summary.stopDuration =
        Math.round(
            reportStopMetrics.stopDuration
        );

    summary.stopCount =
        reportStopMetrics.stopCount;

    if (!shouldIncludeWindows) {
        return {
            summary
        };
    }

    return {
        summary,
        windows
    };
}

function calculateWindowAnalytics(
    deviceId,
    windowStart,
    windowEnd,
    rows,
    context = {}
) {
    const points =
        buildWindowPoints(
            rows,
            windowStart,
            context
        );

    const sampleCount =
        points.filter(point => !point.synthetic).length;

    if (points.length === 0) {
        return null;
    }

    let speedSum = 0;
    let maxSpeed = 0;
    let distanceWithinWindow = 0;

    for (let i = 0; i < points.length - 1; i++) {

        const current = points[i];
        const next = points[i + 1];

        if (
            current.speed <= MOVEMENT_THRESHOLD &&
            next.speed <= MOVEMENT_THRESHOLD
        ) {
            continue;
        }

        distanceWithinWindow += haversine(
            current.lat,
            current.long,
            next.lat,
            next.long
        );
    }

    let engineOnDuration = 0;
    let powerOffDuration = 0;

    let firstIgnitionOn = null;
    let lastIgnitionOff = null;

    for (
        let i = 0;
        i < points.length;
        i++
    ) {
        const current = points[i];
        const next = points[i + 1];
        const previous = points[i - 1];

        if (
            !current.synthetic
        ) {
            speedSum += current.speed;
            maxSpeed = Math.max(maxSpeed, current.speed);
        }


        const segmentEnd =
            next
                ? next.timestamp
                : windowEnd;

        const duration =
            getSegmentDurationSeconds(
                current.timestamp,
                segmentEnd
            );

        if (current.ignition) {

            engineOnDuration += duration;

            if (
                firstIgnitionOn === null
            ) {
                firstIgnitionOn =
                    current.timestamp;
            }

        } else {
            powerOffDuration += duration;
        }

        if (
            previous &&
            previous.ignition &&
            !current.ignition
        ) {
            lastIgnitionOff =
                current.timestamp;
        }

    }

    const idlingDuration =
        calculateIdlingDuration(
            points,
            windowEnd
        );

    const stopMetrics =
        calculateStopMetrics(
            points,
            windowStart,
            windowEnd,
            context.offSessionStart || null
        );

    const firstPoint =
        points[0];

    const lastPoint =
        points[
        points.length - 1
        ];

    let movementDuration =
        Math.max(
            0,
            engineOnDuration - idlingDuration
        );

    const roundedEngineOnDuration =
        Math.round(engineOnDuration);
    const roundedMovementDuration =
        Math.round(movementDuration);
    const roundedIdlingDuration =
        Math.round(idlingDuration);

    if (
        roundedMovementDuration +
        roundedIdlingDuration >
        roundedEngineOnDuration
    ) {
        console.warn(
            "[Analytics] Duration invariant violation",
            {
                deviceId,
                windowStart,
                windowEnd,
                engineOnDuration: roundedEngineOnDuration,
                movementDuration: roundedMovementDuration,
                idlingDuration: roundedIdlingDuration,
                sampleCount
            }
        );
    }

    return {
        deviceId,

        windowStart,
        windowEnd,
        avgSpeed:
            sampleCount > 0
                ? Number(
                    (
                        speedSum /
                        sampleCount
                    ).toFixed(2)
                )
                : 0,

        maxSpeed,

        speedSum:
            Number(
                speedSum.toFixed(2)
            ),

        sampleCount,

        totalDistance:
            Number(
                distanceWithinWindow.toFixed(3)
            ),

        distanceWithinWindow:
            Number(
                distanceWithinWindow.toFixed(3)
            ),

        engineOnDuration:
            roundedEngineOnDuration,

        powerOffDuration:
            Math.round(
                powerOffDuration
            ),

        movementDuration:
            roundedMovementDuration,

        idlingDuration:
            roundedIdlingDuration,

        stopDuration:
            Math.round(
                stopMetrics.stopDuration
            ),

        stopCount:
            stopMetrics.stopCount,

        firstIgnitionOn,
        lastIgnitionOff,

        firstLat:
            firstPoint.lat,

        firstLong:
            firstPoint.long,

        lastLat:
            lastPoint.lat,

        lastLong:
            lastPoint.long,

        firstTimestamp:
            firstPoint.timestamp,

        lastTimestamp:
            lastPoint.timestamp,

        firstIgnition:
            firstPoint.ignition
                ? 1
                : 0,

        lastIgnition:
            lastPoint.ignition
                ? 1
                : 0,

        updatedAt:
            new Date().toISOString()
    };
}

async function computeAndStoreWindow(
    deviceId,
    windowStart,
    windowEnd
) {
    windowStart = normalizeUtc(windowStart);
    windowEnd = normalizeUtc(windowEnd);

    const [
        rowsResult,
        previousPointResult,
        offSessionResult
    ] = await Promise.all([
        clickhouse.query({
            query: `
                SELECT
                    deviceId,
                    lat,
                    long,
                    speed,
                    ignition,
                    timestamp
                FROM telemetry.raw_telemetry
                WHERE deviceId = {deviceId:String}
                  AND timestamp >= parseDateTime64BestEffort({windowStart:String}, 3)
                  AND timestamp < parseDateTime64BestEffort({windowEnd:String}, 3)
                ORDER BY timestamp
            `,
            query_params: {
                deviceId,
                windowStart,
                windowEnd
            },
            format: "JSONEachRow"
        }),

        clickhouse.query({
            query: `
                SELECT
                    deviceId,
                    lat,
                    long,
                    speed,
                    ignition,
                    timestamp
                FROM telemetry.raw_telemetry
                WHERE deviceId = {deviceId:String}
                  AND timestamp < parseDateTime64BestEffort({windowStart:String}, 3)
                ORDER BY timestamp DESC
                LIMIT 1
            `,
            query_params: {
                deviceId,
                windowStart
            },
            format: "JSONEachRow"
        }),

        clickhouse.query({
            query: `
                WITH
                    (
                        SELECT max(timestamp)
                        FROM telemetry.raw_telemetry
                        WHERE deviceId = {deviceId:String}
                          AND ignition = 1
                          AND timestamp < parseDateTime64BestEffort({windowStart:String}, 3)
                    ) AS lastOnBeforeWindow
                SELECT min(timestamp) AS offSessionStart
                FROM telemetry.raw_telemetry
                WHERE deviceId = {deviceId:String}
                  AND ignition = 0
                  AND timestamp < parseDateTime64BestEffort({windowStart:String}, 3)
                  AND timestamp > lastOnBeforeWindow
            `,
            query_params: {
                deviceId,
                windowStart
            },
            format: "JSONEachRow"
        })
    ]);

    const rows =
        await rowsResult.json();

    const previousRows =
        await previousPointResult.json();

    const offSessionRows =
        await offSessionResult.json();

    const previousPoint =
        previousRows.length > 0
            ? previousRows[0]
            : null;

    const previousPointWasOff =
        previousPoint &&
        !normalizePoint(previousPoint).ignition;

    const offSessionStart =
        previousPointWasOff
            ? (
                offSessionRows.length > 0
                    ? offSessionRows[0].offSessionStart
                    : previousPoint.timestamp
            )
            : null;

    const analytics =
        calculateWindowAnalytics(
            deviceId,
            windowStart,
            windowEnd,
            rows,
            {
                previousPoint,
                offSessionStart
            }
        );

    if (!analytics) {
        return null;
    }

    await clickhouse.insert({
        table: "telemetry.analytics_15m",
        values: [analytics],
        format: "JSONEachRow"
    });

    return analytics;
}

module.exports = {
    getAnalytics,
    computeAndStoreWindow,
    buildWindowPoints
};


