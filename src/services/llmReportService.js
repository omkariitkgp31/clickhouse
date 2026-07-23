/**
 * Converts validated telemetry metrics into a concise, structured Groq report
 * analysis. The service limits large inputs, requests JSON-only output, and
 * retries once when a model response cannot satisfy the report schema.
 */

const { z } = require("zod");
const { getGroqClient } = require("../config/groq");

const severitySchema = z.enum(["low", "medium", "high", "critical"]);

const reportInsightsSchema = z.object({
    reportTitle: z.string().min(1),
    executiveSummary: z.string().min(1),
    keyMetrics: z.object({
        distanceKm: z.number(),
        engineRunMinutes: z.number(),
        idleMinutes: z.number(),
        stops: z.number(),
        avgSpeed: z.number(),
        maxSpeed: z.number()
    }),
    insights: z.array(z.object({
        title: z.string().min(1),
        detail: z.string().min(1),
        severity: severitySchema
    })).min(1),
    anomalies: z.array(z.object({
        title: z.string().min(1),
        detail: z.string().min(1),
        severity: severitySchema
    })),
    recommendations: z.array(z.string().min(1)),
    notableWindows: z.array(z.object({
        windowStart: z.string().min(1),
        windowEnd: z.string().min(1),
        summary: z.string().min(1),
        severity: severitySchema
    }))
});

function selectOutlierWindows(windows) {
    return [...windows]
        .sort((left, right) => {
            const score = window =>
                Number(window.maxSpeed || 0) +
                Number(window.distanceKm || 0) * 10 +
                Number(window.idleMinutes || 0) * 2 +
                Number(window.stops || 0) * 5;
            return score(right) - score(left);
        })
        .slice(0, 15);
}

function prepareMetricsForPrompt(metricsJson) {
    const windows = Array.isArray(metricsJson.windows)
        ? metricsJson.windows
        : [];

    return {
        ...metricsJson,
        windows: windows.length > 40
            ? selectOutlierWindows(windows)
            : windows,
        windowSelection: windows.length > 40
            ? `Totals plus the 15 most operationally notable windows from ${windows.length} windows.`
            : `All ${windows.length} report windows.`
    };
}

function buildPrompt(metricsJson) {
    return [
        "You are a fleet telemetry analyst.",
        "Analyze only the provided metrics; do not invent events, causes, or values.",
        "Return exactly one JSON object with no markdown or extra text.",
        "The JSON must have reportTitle, executiveSummary, keyMetrics, insights, anomalies, recommendations, and notableWindows.",
        "Use only low, medium, high, or critical for severity.",
        "keyMetrics must copy the supplied totals for distanceKm, engineRunMinutes, idleMinutes, stops, avgSpeed, and maxSpeed.",
        "Keep the executive summary concise and recommendations actionable.",
        "Use this exact shape; do not replace objects with strings:",
        JSON.stringify({
            reportTitle: "string",
            executiveSummary: "string",
            keyMetrics: {
                distanceKm: 0,
                engineRunMinutes: 0,
                idleMinutes: 0,
                stops: 0,
                avgSpeed: 0,
                maxSpeed: 0
            },
            insights: [{
                title: "string",
                detail: "string",
                severity: "low"
            }],
            anomalies: [{
                title: "string",
                detail: "string",
                severity: "medium"
            }],
            recommendations: ["string"],
            notableWindows: [{
                windowStart: "ISO timestamp from the supplied windows",
                windowEnd: "ISO timestamp from the supplied windows",
                summary: "string",
                severity: "medium"
            }]
        }),
        "Telemetry metrics:",
        JSON.stringify(prepareMetricsForPrompt(metricsJson))
    ].join("\n\n");
}

async function requestInsights(metricsJson) {
    const completion = await getGroqClient().chat.completions.create({
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
        temperature: 0.2,
        response_format: { type: "json_object" },
        messages: [
            {
                role: "user",
                content: buildPrompt(metricsJson)
            }
        ]
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) {
        throw new Error("Groq returned an empty report insight response");
    }

    let parsed;
    try {
        parsed = JSON.parse(content);
    } catch {
        throw new Error("Groq returned invalid JSON for report insights");
    }

    return reportInsightsSchema.parse(parsed);
}

async function generateReportInsights(metricsJson) {
    let validationError;

    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await requestInsights(metricsJson);
        } catch (error) {
            const isValidationFailure =
                error instanceof z.ZodError ||
                error.message.includes("invalid JSON");

            if (!isValidationFailure || attempt === 1) {
                throw error;
            }

            validationError = error;
        }
    }

    throw validationError;
}

module.exports = {
    generateReportInsights,
    prepareMetricsForPrompt,
    reportInsightsSchema
};
