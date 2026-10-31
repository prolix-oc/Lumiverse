import { parse as parseCSS, walk as walkCSS } from 'css-tree'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import ts from 'typescript'
import { resolveConfig, preprocessCSS } from 'vite'
import VARIABLES from '../src/lib/generatedCssVariables'
import { getComponentTemplate } from '../src/lib/componentTemplates'
import { isExcludedPath, joinComponentRegistryPaths } from '../src/lib/componentRegistryJoin'

const root = resolve(import.meta.dir, '..')
const sources: Record<string, string> = {}
for (const name of (readdirSync(resolve(root, 'src'), { recursive: true }) as string[])
  .map((name) => name.replaceAll('\\', '/'))
  .sort()) {
  if (!/^(?:components\/|theme\/|lib\/(?:component|theme|css))/.test(name)) continue
  if (
    !/\.(?:tsx?|css)$/.test(name) ||
    /(?:\.test\.|\.fixture\.|\.isolated\.|\/generated|^generated\/)/.test('/' + name)
  )
    continue
  sources['src/' + name] = readFileSync(resolve(root, 'src', name), 'utf8').replaceAll('\r\n', '\n')
}
const roots: Record<string, string[]> = {}
const parts: Record<string, string[]> = {}
for (const [path, text] of Object.entries(sources)) {
  if (!path.endsWith('.tsx')) continue
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const name = node.name.getText(source)
      if (name === 'data-component') (roots[node.initializer.text] ??= []).push(path)
      if (name === 'data-part') (parts[path] ??= []).push(node.initializer.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
}
const components = joinComponentRegistryPaths(
  Object.keys(sources).filter((p) => p.endsWith('.module.css')),
  Object.keys(sources).filter((p) => p.endsWith('.tsx')),
)
  .filter((entry) => entry.cssPath && !isExcludedPath('/' + entry.cssPath))
  .map((entry) => ({
    ...entry,
    rootSelector: roots[entry.component] ? `[data-component="${entry.component}"]` : null,
    renderSources: [...new Set(roots[entry.component] ?? [])],
    parts: [...new Set((roots[entry.component] ?? []).flatMap((path) => parts[path] ?? []))],
  }))
const docs: Record<string, string> = {}
for (const folder of ['user-docs', 'developer-docs']) {
  const base = resolve(root, '..', folder, 'docs')
  for (const name of (readdirSync(base, { recursive: true }) as string[])
    .map((name) => name.replaceAll('\\', '/'))
    .sort()) {
    if (name.endsWith('.md'))
      docs[folder + '/' + name] = readFileSync(resolve(base, name), 'utf8').replaceAll('\r\n', '\n')
  }
}
const config = await resolveConfig({ root, logLevel: 'silent' }, 'build')
const compiled = []
for (const entry of components) {
  // Module hashes include the original line endings.
  const cssPath = entry.cssPath ? resolve(root, entry.cssPath.replace(/^\//, '')) : undefined
  const css = cssPath ? readFileSync(cssPath, 'utf8') : undefined
  const result = css && cssPath ? await preprocessCSS(css, cssPath, config) : undefined
  // Animation names share the module export map.
  const classes = new Set<string>()
  if (result)
    walkCSS(parseCSS(result.code), {
      visit: 'ClassSelector',
      enter(node) {
        classes.add(node.name)
      },
    })
  const classSelectors: Record<string, string> = {}
  for (const [name, value] of Object.entries(result?.modules ?? {})) {
    const names = value.split(/\s+/).filter(Boolean)
    if (names.some((name) => classes.has(name))) {
      classSelectors[name] = names.map((name) => '.' + name).join('')
    }
  }
  compiled.push({ ...entry, classSelectors, ...getComponentTemplate(entry.component) })
}
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const body = JSON.stringify({ version, sources, docs, components: compiled, variables: VARIABLES })
const hash = createHash('sha256').update(body).digest('hex')
const asset = `assets/theme-reference.${hash}.json`
const check = process.argv.includes('--check')
const assetPath = resolve(root, 'public', asset)
if (check) {
  if (!existsSync(assetPath) || readFileSync(assetPath, 'utf8') !== body)
    throw new Error('Theme references are stale. Run generate before building.')
} else {
  mkdirSync(dirname(assetPath), { recursive: true })
  writeFileSync(assetPath, body)
  const publicRoot = resolve(root, 'public', 'assets')
  for (const old of readdirSync(publicRoot)) {
    if (/^theme-reference\.[a-f0-9]{64}\.json$/.test(old) && old !== asset.split('/').pop()) {
      const target = resolve(publicRoot, old)
      if (!target.startsWith(publicRoot + sep)) throw new Error('Invalid generated asset path')
      unlinkSync(target)
    }
  }
}
const indexPath = resolve(root, 'public/assets/theme-reference-index.json')
const index = JSON.stringify({ version, hash, asset })
if (check) {
  if (!existsSync(indexPath) || readFileSync(indexPath, 'utf8') !== index)
    throw new Error('Theme reference index is stale.')
} else writeFileSync(indexPath, index)
console.log(
  `Theme reference: ${components.length} components, ${Object.keys(sources).length} sources, ${Object.keys(docs).length} guides (${hash.slice(0, 12)})`,
)
