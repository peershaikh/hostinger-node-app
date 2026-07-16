"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const stationMapperPath = path_1.default.resolve(__dirname, '../utils/stationMapper.ts');
const outputPath = path_1.default.resolve(__dirname, '../data/offline_aliases.json');
async function main() {
    console.log('--- GENERATING OFFLINE ALIASES JSON FROM STATIONMAPPER.TS ---');
    if (!fs_1.default.existsSync(stationMapperPath)) {
        console.error(`Error: stationMapper.ts not found at ${stationMapperPath}`);
        process.exit(1);
    }
    const content = fs_1.default.readFileSync(stationMapperPath, 'utf8');
    const match = content.match(/const ALIASES: Record<string, string \| string\[\]> = (\{[\s\S]*?\});/);
    if (!match) {
        console.error('Error: Could not locate ALIASES block in stationMapper.ts');
        process.exit(1);
    }
    // Use a safe Function constructor to parse the typescript object block
    let ALIASES;
    try {
        ALIASES = new Function(`return ${match[1]}`)();
    }
    catch (e) {
        console.error('Error: Failed to evaluate ALIASES block:', e.message);
        process.exit(1);
    }
    // Convert all values to string[] and sanitize keys
    const sanitized = {};
    for (const [key, val] of Object.entries(ALIASES)) {
        const cleanKey = key.toUpperCase().trim();
        const cleanVal = (Array.isArray(val) ? val : [val]).map(v => v.toUpperCase().trim());
        sanitized[cleanKey] = cleanVal;
    }
    // Ensure the target directory exists
    const targetDir = path_1.default.dirname(outputPath);
    if (!fs_1.default.existsSync(targetDir)) {
        fs_1.default.mkdirSync(targetDir, { recursive: true });
    }
    fs_1.default.writeFileSync(outputPath, JSON.stringify(sanitized, null, 2), 'utf8');
    console.log(`Successfully generated offline_aliases.json at ${outputPath}`);
    console.log(`Total aliases exported: ${Object.keys(sanitized).length}`);
}
main().catch(err => {
    console.error('Execution failed:', err);
    process.exit(1);
});
