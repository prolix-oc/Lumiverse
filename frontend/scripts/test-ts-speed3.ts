import ts from "typescript";
import path from "path";

const tsConfigPath = path.join(process.cwd(), "tsconfig.json");
const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
const parsedCommandLine = ts.parseJsonConfigFileContent(
  configFile.config,
  ts.sys,
  process.cwd()
);

parsedCommandLine.options.incremental = true;
parsedCommandLine.options.tsBuildInfoFile = path.join(process.cwd(), ".tsbuildinfo_extract");

console.time("createIncrementalProgram");
const program = ts.createIncrementalProgram({
  rootNames: parsedCommandLine.fileNames,
  options: parsedCommandLine.options,
});
console.timeEnd("createIncrementalProgram");

console.time("getTypeChecker");
const checker = program.getProgram().getTypeChecker();
console.timeEnd("getTypeChecker");
