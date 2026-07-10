const express = require("express");

const router = express.Router();

const { getAnalytics } = require("../controllers/analyticController");

router.get("/", getAnalytics);

module.exports = router;