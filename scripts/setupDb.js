require("dotenv").config();

const clickhouse = require("../src/config/clickhouse");

async function setup() {
    try {

        // Raw Telemetry Table
        await clickhouse.command({
            query: `
                CREATE DATABASE IF NOT EXISTS telemetry
            `,
        });

        // Analytics Table
        await clickhouse.command({
            query: `
                CREATE TABLE IF NOT EXISTS telemetry.raw_telemetry
                (
                    deviceId String,

                    lat Float64,
                    long Float64,

                    speed Float32,

                    direction UInt16,

                    ignition UInt8,

                    mainPower UInt8,

                    timestamp DateTime64(3,'UTC'),

                    receivedAt DateTime64(3,'UTC')
                )
                ENGINE = MergeTree()
                PARTITION BY toYYYYMM(timestamp)
                ORDER BY (deviceId, timestamp)
            `,
        });

        // Dirty Windows Table
        await clickhouse.command({
            query: `
        CREATE TABLE IF NOT EXISTS telemetry.analytics_15m
        (
            deviceId String,

            windowStart DateTime64(3,'UTC'),
            windowEnd DateTime64(3,'UTC'),

            avgSpeed Float64,
            maxSpeed Float64,

            speedSum Float64,
            sampleCount UInt64,

            totalDistance Float64,
            distanceWithinWindow Float64,

            firstLat Nullable(Float64),
            firstLong Nullable(Float64),

            lastLat Nullable(Float64),
            lastLong Nullable(Float64),

            firstTimestamp Nullable(DateTime64(3,'UTC')),
            lastTimestamp Nullable(DateTime64(3,'UTC')),

            firstIgnition Nullable(UInt8),
            lastIgnition Nullable(UInt8),

            firstIgnitionOn Nullable(DateTime64(3,'UTC')),
            lastIgnitionOff Nullable(DateTime64(3,'UTC')),

            engineOnDuration UInt64,
            powerOffDuration UInt64,

            movementDuration UInt64,
            idlingDuration UInt64,

            stopDuration UInt64,
            stopCount UInt32,

            updatedAt DateTime64(3,'UTC')
        )
        ENGINE = ReplacingMergeTree(updatedAt)
        PARTITION BY toYYYYMM(windowStart)
        ORDER BY (deviceId, windowStart)
    `,
        });

        await clickhouse.command({
            query: `
                CREATE TABLE IF NOT EXISTS telemetry.dirty_windows
                (
                    deviceId String,
                                
                    windowStart DateTime64(3,'UTC'),
                    windowEnd DateTime64(3,'UTC'),
                                
                    status Enum(
                        'pending' = 1,
                        'done' = 2
                    ),

                    version UInt64,
                
                    createdAt DateTime64(3,'UTC'),
                    processedAt Nullable(DateTime64(3,'UTC'))
                )
                ENGINE = ReplacingMergeTree(version)
                ORDER BY (deviceId, windowStart)
            `,
        });

        console.log("Database setup complete");
        console.log("Created:");
        console.log(" - telemetry.raw_telemetry");
        console.log(" - telemetry.analytics_15m");
        console.log(" - telemetry.dirty_windows");

    } catch (err) {
        console.error("Setup Error:", err);
    }
}

setup();