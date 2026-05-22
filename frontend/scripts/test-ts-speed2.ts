import ts from "typescript";
import path from "path";
import { Glob } from "bun";

console.time("Globbing");
const glob = new Glob("src/components/**/*.tsx");
const componentFiles = Array.from(glob.scanSync({ cwd: process.cwd(), absolute: true }));
console.timeEnd("Globbing");

console.log("Component files:", componentFiles.length);

console.time("createProgram");
const program = ts.createProgram(componentFiles, {
  skipLibCheck: true,
  noEmit: true,
  target: ts.ScriptTarget.Latest,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
});
console.timeEnd("createProgram");

console.time("getTypeChecker");
const checker = program.getTypeChecker();
console.timeEnd("getTypeChecker");
