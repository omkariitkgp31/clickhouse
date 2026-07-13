require("dotenv").config();
const { computeAndStoreWindow } = require("../src/services/analyticService");

async function run() {
    const deviceId = '864524076858962';
    const baseDate = new Date('2026-06-08T00:00:00.000Z');
    
    console.log("Running benchmark of computeAndStoreWindow for 96 windows...");
    
    for (let i = 0; i < 96; i++) {
        const start = new Date(baseDate.getTime() + i * 15 * 60 * 1000);
        const end = new Date(start.getTime() + 15 * 60 * 1000);
        
        // Format as YYYY-MM-DD HH:mm:ss.SSS
        const startStr = start.toISOString().replace('T', ' ').replace('Z', '');
        const endStr = end.toISOString().replace('T', ' ').replace('Z', '');
        
        await computeAndStoreWindow(deviceId, startStr, endStr);
    }
    
    console.log("Benchmark complete!");
    process.exit(0);
}

run().catch((err) => {
    console.error(err);
    process.exit(1);
});
