require("dotenv").config();
const { createClient } = require("@clickhouse/client");

const ch = createClient({
    url: process.env.CLICKHOUSE_HOST,
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
});

async function check() {
    const db = await ch.query({ query: "SHOW DATABASES", format: "JSONEachRow" });
    console.log("Databases:", await db.json());

    const tables = await ch.query({ query: "SHOW TABLES FROM telemetry", format: "JSONEachRow" });
    console.log("Tables in telemetry:", await tables.json());
}

check().catch(console.error).finally(() => ch.close());
