/**
 * Defines the report-generation HTTP endpoint separately from telemetry and
 * analytics routes so clients can request a finished document in one call.
 */

const express = require("express");
const { generateReport } = require("../controllers/reportController");

const router = express.Router();

router.post("/generate", generateReport);

module.exports = router;
