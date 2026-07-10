const express = require("express");

const router = express.Router();

const {
    ingestTelemetry,
    ingestBulkTelemetry,
    getTelemetry,
    getBufferSize
} = require("../controllers/telemetryController");

router.post("/", ingestTelemetry);
router.post("/bulk", ingestBulkTelemetry);  // <-- bulk ingest
router.get("/", getTelemetry);
router.get("/buffer-size", getBufferSize);

module.exports = router;
