require("dotenv").config();

require("./jobs/batchInsert.job");
require("./jobs/analytics.job");
require("./jobs/dirtWindowCleanUp.job");

const express = require("express");

const telemetryRoutes = require("./routes/telemetry");
const analyticRoute = require("./routes/analytic");
const reportRoute = require("./routes/report");

const app = express();

app.use(express.json({ limit: "50mb" }));

app.use("/telemetry", telemetryRoutes);
app.use("/analytics", analyticRoute);
app.use("/reports", reportRoute);

app.listen(process.env.PORT, () => {
    console.log(`Server running on ${process.env.PORT}`);
});
