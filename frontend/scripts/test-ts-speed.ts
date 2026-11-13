import ts from "typescript";
import path from "path";

console.time("Config Parsing");
const tsConfigPath = path.join(process.cwd(), "tsconfig.json");
const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
const parsedCommandLine = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  process.cwd()
);
console.timeEnd("Config Parsing");

console.log("Total files:", parsedCommandLine.fileNames.length);

console.time("createProgram");
const program = ts.createProgram(parsedCommandLine.fileNames, parsedCommandLine.options);
console.timeEnd("createProgram");

console.time("getTypeChecker");
const checker = program.getTypeChecker();
console.timeEnd("getTypeChecker");
