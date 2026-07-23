/**
 * Creates the single Groq SDK client shared by report-generation requests.
 * The API key remains in environment configuration so it is never stored in
 * source code or included in generated report data.
 */

const Groq = require("groq-sdk");

let client;

function getGroqClient() {
    if (!process.env.GROQ_API_KEY) {
        throw new Error("GROQ_API_KEY is required to generate report insights");
    }

    if (!client) {
        client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    }

    return client;
}

module.exports = { getGroqClient };
