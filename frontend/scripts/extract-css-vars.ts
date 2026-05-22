import fs from "fs";
import path from "path";

// A script to extract CSS variables and their initial values
const variablesCssPath = path.join(process.cwd(), "src/theme/variables.css");
const content = fs.readFileSync(variablesCssPath, "utf-8");

const rootMatch = content.match(/:root\s*{([^}]+)}/);
if (!rootMatch) {
  console.error("Could not find :root in variables.css");
  process.exit(1);
}

const rootContent = rootMatch[1];
const varRegex = /(--lumiverse-[a-zA-Z0-9-]+)\s*:\s*([^;]+);/g;
let match;
const result: Record<string, string> = {};

while ((match = varRegex.exec(rootContent)) !== null) {
  result[match[1]] = match[2].trim();
}

const outPath = path.join(process.cwd(), "src/lib/generatedCssVariables.ts");
fs.writeFileSync(outPath, `// AUTO-GENERATED - DO NOT EDIT\nexport default ${JSON.stringify(result, null, 2)} as Record<string, string>;\n`);
console.log("Wrote", Object.keys(result).length, "CSS variables to", outPath);
