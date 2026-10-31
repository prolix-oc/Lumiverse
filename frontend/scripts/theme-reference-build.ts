import { createHash } from 'node:crypto'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, walk } from 'css-tree'
import ts from 'typescript'
import type { Plugin, ResolvedConfig } from 'vite'
import { createThemeReference } from './generate-theme-reference.ts'

export function themeReferenceBuild(): Plugin {
  let config: ResolvedConfig
  const moduleClasses = new Map<string, Set<string>>()
  return {
    name: 'lumiverse-theme-reference-output',
    apply: 'build',
    enforce: 'post',
    buildStart() {
      moduleClasses.clear()
    },
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
    async generateBundle(_options, output) {
      if (!output['index.html']) return
      // Build references directly; runners and clean checkouts need no public cache.
      const reference = await createThemeReference(config)
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
      this.emitFile({ type: 'asset', fileName: asset, source: body })
      this.emitFile({
        type: 'asset',
        fileName: 'assets/theme-reference-index.json',
        source: JSON.stringify({ version: reference.version, hash, asset }),
      })
    },
    writeBundle(options, output) {
      if (!output['index.html']) return
      // Older generation steps may still leave source references in public/.
      // Keep only references emitted by this build when Vite copies those files.
      const assetsDir = resolve(config.root, options.dir ?? config.build.outDir, 'assets')
      if (!existsSync(assetsDir)) return
      for (const name of readdirSync(assetsDir)) {
        if (/^theme-reference\.[a-f0-9]{64}\.json$/.test(name) && !output[`assets/${name}`]) {
          unlinkSync(resolve(assetsDir, name))
        }
      }
    },
  }
}
