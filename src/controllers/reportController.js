/**
 * Validates incoming report requests and maps report-service results into
 * consistent Express responses without exposing internal generation details.
 */

const { z } = require("zod");
const { isBefore } = require("../utils/dateTime");
const reportService = require("../services/reportService");

const requestSchema = z.object({
    deviceId: z.string().trim().min(1, "deviceId is required"),
    from: z.string().min(1, "from is required"),
    to: z.string().min(1, "to is required"),
    format: z.enum(["docx", "pdf"]).default("docx")
});

async function generateReport(req, res) {
    try {
        const request = requestSchema.parse(req.body || {});

        if (!isBefore(request.from, request.to)) {
            return res.status(400).json({
                success: false,
                error: "from must be before to"
            });
        }

        const result = await reportService.generateReport(request);

        return res.status(201).json({
            success: true,
            data: result
        });
    } catch (error) {
        if (error instanceof z.ZodError) {
            return res.status(400).json({
                success: false,
                error: "Invalid report request",
                details: error.issues
            });
        }

        console.error("[Report] Generation failed:", error.message);
        return res.status(500).json({
            success: false,
            error: "Unable to generate report"
        });
    }
}

module.exports = { generateReport };
