const { buildWindowPoints } = require("../src/services/analyticService");
const assert = require("assert");

// Mock context and windowStart for test cases
const windowStart = "2026-07-10T12:00:00.000Z";

function runTests() {
    console.log("Starting unit tests for buildWindowPoints...");

    // Test 1: In-order inputs (standard scenario)
    try {
        const inOrderRows = [
            { lat: 12.97, long: 77.59, speed: 40.0, ignition: 1, timestamp: "2026-07-10 12:01:00.000" },
            { lat: 12.98, long: 77.60, speed: 45.0, ignition: 1, timestamp: "2026-07-10 12:05:00.000" },
            { lat: 12.99, long: 77.61, speed: 50.0, ignition: 1, timestamp: "2026-07-10 12:10:00.000" }
        ];

        const points = buildWindowPoints(inOrderRows, windowStart);

        assert.strictEqual(points.length, 3);
        assert.strictEqual(points[0].timestamp, "2026-07-10 12:01:00.000");
        assert.strictEqual(points[1].timestamp, "2026-07-10 12:05:00.000");
        assert.strictEqual(points[2].timestamp, "2026-07-10 12:10:00.000");
        console.log("✓ Test 1 Passed: In-order inputs processed and order preserved.");
    } catch (err) {
        console.error("✗ Test 1 Failed:", err);
        process.exit(1);
    }

    // Test 2: Out-of-order inputs (safeguard check)
    try {
        const outOfOrderRows = [
            { lat: 12.97, long: 77.59, speed: 40.0, ignition: 1, timestamp: "2026-07-10 12:05:00.000" },
            { lat: 12.98, long: 77.60, speed: 45.0, ignition: 1, timestamp: "2026-07-10 12:01:00.000" }, // out of order!
            { lat: 12.99, long: 77.61, speed: 50.0, ignition: 1, timestamp: "2026-07-10 12:10:00.000" }
        ];

        assert.throws(() => {
            buildWindowPoints(outOfOrderRows, windowStart);
        }, /buildWindowPoints input is out of order/);

        console.log("✓ Test 2 Passed: Out-of-order inputs correctly triggered local safeguard (threw error).");
    } catch (err) {
        console.error("✗ Test 2 Failed:", err);
        process.exit(1);
    }

    // Test 3: Duplicated timestamps (deduplication check)
    try {
        const duplicateRows = [
            { lat: 12.97, long: 77.59, speed: 40.0, ignition: 1, timestamp: "2026-07-10 12:01:00.000" },
            { lat: 12.97, long: 77.59, speed: 40.0, ignition: 1, timestamp: "2026-07-10 12:01:00.000" }, // duplicate (should filter)
            { lat: 12.98, long: 77.60, speed: 45.0, ignition: 1, timestamp: "2026-07-10 12:05:00.000" }
        ];

        const points = buildWindowPoints(duplicateRows, windowStart);

        assert.strictEqual(points.length, 2);
        assert.strictEqual(points[0].timestamp, "2026-07-10 12:01:00.000");
        assert.strictEqual(points[1].timestamp, "2026-07-10 12:05:00.000");
        console.log("✓ Test 3 Passed: Duplicated timestamps successfully deduplicated without throwing.");
    } catch (err) {
        console.error("✗ Test 3 Failed:", err);
        process.exit(1);
    }

    // Test 4: Boundary / Previous Point behavior
    try {
        const rows = [
            { lat: 12.98, long: 77.60, speed: 45.0, ignition: 1, timestamp: "2026-07-10 12:05:00.000" }
        ];
        const context = {
            previousPoint: { lat: 12.97, long: 77.59, speed: 40.0, ignition: 1, timestamp: "2026-07-10 11:58:00.000" }
        };

        const points = buildWindowPoints(rows, windowStart, context);

        // Expect two points: synthetic boundary point at windowStart + the actual point
        assert.strictEqual(points.length, 2);
        assert.strictEqual(points[0].synthetic, true);
        assert.strictEqual(points[0].timestamp, windowStart);
        assert.strictEqual(points[1].synthetic, false);
        assert.strictEqual(points[1].timestamp, "2026-07-10 12:05:00.000");
        console.log("✓ Test 4 Passed: Boundary synthetic point correctly inserted at the beginning.");
    } catch (err) {
        console.error("✗ Test 4 Failed:", err);
        process.exit(1);
    }

    // Test 5: Empty/Single Point checks
    try {
        const emptyPoints = buildWindowPoints([], windowStart);
        assert.strictEqual(emptyPoints.length, 0);

        const singleRow = [{ lat: 12.97, long: 77.59, speed: 40.0, ignition: 1, timestamp: "2026-07-10 12:01:00.000" }];
        const singlePoint = buildWindowPoints(singleRow, windowStart);
        assert.strictEqual(singlePoint.length, 1);
        assert.strictEqual(singlePoint[0].timestamp, "2026-07-10 12:01:00.000");

        console.log("✓ Test 5 Passed: Empty and single-point arrays handled correctly.");
    } catch (err) {
        console.error("✗ Test 5 Failed:", err);
        process.exit(1);
    }

    console.log("All unit tests passed successfully!\n");
}

runTests();
