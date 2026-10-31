import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, walk } from 'css-tree'
import ts from 'typescript'
import type { Plugin, ResolvedConfig } from 'vite'

export function themeReferenceBuild(): Plugin {
  let config: ResolvedConfig
  const moduleClasses = new Map<string, Set<string>>()
  return {
    name: 'lumiverse-theme-reference-output',
    apply: 'build',
    enforce: 'post',
    transform(code, id) {
      if (!id.endsWith('.module.css')) return
      const values = new Set<string>()
      const source = ts.createSourceFile(
        id + '.js',
        code,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.JS,
      )
      const visit = (node: ts.Node) => {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
          for (const part of node.text.split(/\s+/)) values.add(part)
        }
        ts.forEachChild(node, visit)
      }
      visit(source)
      moduleClasses.set(id, values)
    },
    configResolved(value) {
      config = value
    },
    writeBundle(options, output) {
      if (!output['index.html']) return
      const root = resolve(config.root, options.dir ?? config.build.outDir)
      const indexPath = resolve(root, 'assets/theme-reference-index.json')
      const index = JSON.parse(readFileSync(indexPath, 'utf8'))
      if (
        !/^[a-f0-9]{64}$/.test(index.hash) ||
        index.asset !== `assets/theme-reference.${index.hash}.json`
      )
        throw new Error('Invalid theme reference index')
      const oldPath = resolve(root, index.asset)
      const reference = JSON.parse(readFileSync(oldPath, 'utf8')) as {
        components: Array<{ classSelectors: Record<string, string> }>
      }
      const wanted = new Set(
        reference.components.flatMap((component) =>
          Object.values(component.classSelectors).flatMap((selector) =>
            selector.split('.').filter(Boolean),
          ),
        ),
      )
      const included = new Set<string>()
      for (const file of Object.values(output)) {
        if (file.type === 'asset' && file.fileName.endsWith('.css')) {
          const source =
            typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source)
          walk(parse(source), {
            visit: 'ClassSelector',
            enter(node) {
              if (wanted.has(node.name)) included.add(node.name)
            },
          })
        } else if (file.type === 'chunk') {
          for (const id of Object.keys(file.modules)) {
            for (const name of moduleClasses.get(id) ?? []) {
              if (wanted.has(name)) included.add(name)
            }
          }
        }
      }
      for (const component of reference.components) {
        component.classSelectors = Object.fromEntries(
          Object.entries(component.classSelectors).filter(([, selector]) =>
            selector
              .split('.')
              .filter(Boolean)
              .every((name) => included.has(name)),
          ),
        )
      }
      const body = JSON.stringify(reference)
      const hash = createHash('sha256').update(body).digest('hex')
      const asset = `assets/theme-reference.${hash}.json`
      writeFileSync(resolve(root, asset), body)
      writeFileSync(indexPath, JSON.stringify({ ...index, hash, asset }))
      if (hash !== index.hash) unlinkSync(oldPath)
    },
  }
}
