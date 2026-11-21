import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const nativeAPI = "randomUUID";
const forbidden = [
  new RegExp(`\\b${nativeAPI}\\s*(?:\\?\\.)?\\s*\\(`),
  new RegExp(`\\[\\s*['"]${nativeAPI}['"]\\s*\\]\\s*(?:\\?\\.)?\\s*\\(`),
  new RegExp(`\\bimport\\s*\\{[^}]*\\b${nativeAPI}\\b[^}]*\\}\\s*from\\s*['"](?:node:)?crypto['"]`),
  new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${nativeAPI}\\b[^}]*\\}\\s*=`),
];

function usesNativeUUID(source: string): boolean {
  // Availability probes in HTTP compatibility tests are intentional. Only
  // generation and imports/destructuring of the native generator are forbidden.
  const code = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/.*$/gm, "");
  return forbidden.some((pattern) => pattern.test(code));
}

test("UUID policy catches native calls and aliased imports but allows availability probes", () => {
  for (const source of [
    `crypto.${nativeAPI}()`,
    `globalThis.crypto.${nativeAPI}?.()`,
    `crypto['${nativeAPI}']()`,
    `${nativeAPI}()`,
    `import { ${nativeAPI} as uuid } from 'node:crypto'`,
    `const { ${nativeAPI}: uuid } = crypto`,
  ]) expect(usesNativeUUID(source)).toBe(true);
  for (const source of [
    `typeof crypto.${nativeAPI}`,
    `Object.defineProperty(crypto, '${nativeAPI}', { value: undefined })`,
    `// crypto.${nativeAPI}()`,
    `/* crypto.${nativeAPI}() */`,
    `import { uuidv4 } from './uuid'; uuidv4()`,
  ]) expect(usesNativeUUID(source)).toBe(false);
});

test("project code uses the shared UUID helper in every runtime", () => {
  const violations: string[] = [];
  const ignored = new Set(["node_modules", "vendor", "dist", ".tmp", "target", "site"]);
  function visit(directory: string, recursive = true) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && recursive && !ignored.has(entry.name)) visit(path);
      else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name) && usesNativeUUID(readFileSync(path, "utf8"))) {
        violations.push(relative(root, path));
      }
    }
  }
  // The packaged Stream Deck SDK is third-party generated code; its authored
  // source and build scripts are checked alongside all other project runtimes.
  visit(root, false);
  for (const directory of ["src", "frontend/src", "frontend/scripts", "desktop/src", "desktop/tests", "scripts", "tests", "stream-deck/src", "stream-deck/scripts"]) {
    visit(join(root, directory));
  }
  expect(violations.sort()).toEqual([]);
});
