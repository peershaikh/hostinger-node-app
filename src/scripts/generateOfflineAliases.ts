import fs from 'fs';
import path from 'path';

const stationMapperPath = path.resolve(__dirname, '../utils/stationMapper.ts');
const outputPath = path.resolve(__dirname, '../data/offline_aliases.json');

async function main() {
  console.log('--- GENERATING OFFLINE ALIASES JSON FROM STATIONMAPPER.TS ---');
  
  if (!fs.existsSync(stationMapperPath)) {
    console.error(`Error: stationMapper.ts not found at ${stationMapperPath}`);
    process.exit(1);
  }
  
  const content = fs.readFileSync(stationMapperPath, 'utf8');
  const match = content.match(/const ALIASES: Record<string, string \| string\[\]> = (\{[\s\S]*?\});/);
  
  if (!match) {
    console.error('Error: Could not locate ALIASES block in stationMapper.ts');
    process.exit(1);
  }
  
  // Use a safe Function constructor to parse the typescript object block
  let ALIASES: Record<string, string | string[]>;
  try {
    ALIASES = new Function(`return ${match[1]}`)();
  } catch (e: any) {
    console.error('Error: Failed to evaluate ALIASES block:', e.message);
    process.exit(1);
  }
  
  // Convert all values to string[] and sanitize keys
  const sanitized: Record<string, string[]> = {};
  for (const [key, val] of Object.entries(ALIASES)) {
    const cleanKey = key.toUpperCase().trim();
    const cleanVal = (Array.isArray(val) ? val : [val]).map(v => v.toUpperCase().trim());
    sanitized[cleanKey] = cleanVal;
  }
  
  // Ensure the target directory exists
  const targetDir = path.dirname(outputPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }
  
  fs.writeFileSync(outputPath, JSON.stringify(sanitized, null, 2), 'utf8');
  console.log(`Successfully generated offline_aliases.json at ${outputPath}`);
  console.log(`Total aliases exported: ${Object.keys(sanitized).length}`);
}

main().catch(err => {
  console.error('Execution failed:', err);
  process.exit(1);
});
