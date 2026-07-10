const { createClient } = require("@clickhouse/client");/*this line imports the 
createClient function from the @clickhouse/client package, which is used to create 
a client instance for interacting with a ClickHouse database. */

const clickhouse = createClient({
    url: process.env.CLICKHOUSE_HOST,
    username: process.env.CLICKHOUSE_USER || "default",
    password: process.env.CLICKHOUSE_PASSWORD || "",
});//this createClient function initializes a new ClickHouse 
//client instance with the specified configuration options, including 
//the URL of the ClickHouse server, the username, and the password.

module.exports = clickhouse;