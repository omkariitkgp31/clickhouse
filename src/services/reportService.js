/**
 * Coordinates the complete report pipeline: retrieve analytics, create LLM
 * insights, persist their combined JSON input, run Python document generation,
 * and return the resulting report file path to the HTTP layer.
 */

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
    getDeviceMetricsForRange
} = require("./reportDataService");
const {
    generateReportInsights
} = require("./llmReportService");

function getReportsDirectory() {
    return path.resolve(process.cwd(), process.env.REPORTS_OUTPUT_DIR || "./reports");
}

function runPythonGenerator(inputPath, outputPath, format) {
    const pythonBin = process.env.PYTHON_BIN || "python";
    const generatorPath = path.resolve(
        process.cwd(),
        "report-generator",
        "generate_report.py"
    );

    return new Promise((resolve, reject) => {
        const child = spawn(pythonBin, [
            generatorPath,
            "--input", inputPath,
            "--output", outputPath,
            "--format", format
        ], {
            windowsHide: true
        });

        let stderr = "";
        child.stderr.on("data", chunk => {
            stderr += chunk.toString();
        });

        child.on("error", error => {
            reject(new Error(`Unable to start Python report generator: ${error.message}`));
        });

        child.on("close", code => {
            if (code === 0) {
                resolve();
                return;
            }

            reject(new Error(
                `Python report generator exited with code ${code}: ${stderr.trim()}`
            ));
        });
    });
}

async function generateReport({ deviceId, from, to, format }) {
    const metrics = await getDeviceMetricsForRange(deviceId, from, to);
    const insights = await generateReportInsights(metrics);
    const reportsDirectory = getReportsDirectory();
    const temporaryDirectory = path.join(reportsDirectory, "tmp");
    const reportId = crypto.randomUUID();
    const inputPath = path.join(temporaryDirectory, `${reportId}.json`);
    const documentPath = path.join(reportsDirectory, `${reportId}.${format}`);

    await fs.mkdir(temporaryDirectory, { recursive: true });
    await fs.writeFile(inputPath, JSON.stringify({ metrics, insights }, null, 2));
    await runPythonGenerator(inputPath, documentPath, format);
    await fs.access(documentPath);

    return {
        reportId,
        format,
        documentPath,
        inputPath
    };
}

module.exports = { generateReport };
