import fs from "fs";
import path from "path";
import props from "../src/lib/generatedComponentProps";

const tsxFiles = require('child_process').execSync('find src/components -name "*.tsx"').toString().split('\n').filter(Boolean);
const expectedComponents = tsxFiles.map(f => path.basename(f, '.tsx'));
const actualComponents = Object.keys(props);

const missing = expectedComponents.filter(c => !actualComponents.includes(c));
console.log(`Expected: ${expectedComponents.length}, Actual: ${actualComponents.length}`);
console.log(`Missing: ${missing.length}`);
if (missing.length > 0) {
  console.log(missing.slice(0, 20));
}
