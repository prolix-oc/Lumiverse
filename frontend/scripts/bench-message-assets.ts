import { loadBenchmarkFunction, measureBenchmarkFixture } from './benchmark-source'
import type { replaceHtmlImageSources } from '../src/lib/htmlImageSources'

// Usage: bun scripts/bench-message-assets.ts [git-ref|-] [html|gallery|markdown|titles]
const ref = process.argv[2] === '-' ? undefined : process.argv[2]
const target = process.argv[3]
const messagePath = 'frontend/src/components/chat/MessageContent.tsx'
const galleryPath = 'frontend/src/lib/galleryImageReference.ts'
type ResolveAsset = (raw: string, assets: Record<string, string>) => string
let scanImages: typeof replaceHtmlImageSources | undefined
const globals = {
  replaceHtmlImageSources: (...args: Parameters<typeof replaceHtmlImageSources>) => {
    scanImages ??= loadBenchmarkFunction<typeof replaceHtmlImageSources>('frontend/src/lib/htmlImageSources.ts', 'replaceHtmlImageSources', ref)
    return scanImages(...args)
  },
  resolveGalleryImageId: loadBenchmarkFunction(galleryPath, 'resolveGalleryImageId', ref),
  resolveGalleryImageSourcesInHtml: undefined as ResolveAsset | undefined,
}
globals.resolveGalleryImageSourcesInHtml = loadBenchmarkFunction<ResolveAsset>(galleryPath, 'resolveGalleryImageSourcesInHtml', ref, globals)
const assets = { a: 'asset-id', portrait: 'portrait-id', 'gallery://portrait': 'gallery-id' }
const cases = {
  titles: {
    path: messagePath, functionName: 'resolveMarkdownImgTags', normal: '![Portrait](portrait "A portrait")',
    fixtures: {
      missingTitles: (n: number) => '![Portrait](portrait' + ' '.repeat(n) + 'x)',
      validTitles: (n: number) => '![Portrait](portrait' + ' '.repeat(n) + '"title")',
      quotedRuns: (n: number) => '![Portrait](portrait' + ' "x'.repeat(n) + ')',
    },
  },
  markdown: {
    path: messagePath, functionName: 'resolveMarkdownImgTags', normal: '![Portrait](portrait) ![Remote](https://example.com/image.png)',
    fixtures: {
      missingLabels: (n: number) => '!['.repeat(n),
      rejectedLabels: (n: number) => '!['.repeat(n) + '] ordinary ![Portrait](portrait)',
      missingSources: (n: number) => '!['.repeat(n) + '](portrait',
    },
  },
  html: {
    path: messagePath, functionName: 'resolveImgSrcAssetTags', normal: '<p>Text</p><img class="portrait" src="portrait"><img src="https://example.com/image.png">',
    fixtures: {
      missingEnds: (n: number) => '<img '.repeat(n) + 'src="a" '.repeat(n),
      outsideSources: (n: number) => 'src="a" '.repeat(n) + '<img src="a">' + 'src="a" '.repeat(n),
      failedSources: (n: number) => '<img '.repeat(n) + 'src="" '.repeat(n) + '>',
      repeatedSources: (n: number) => '<img ' + 'src="a" '.repeat(n) + '>',
      quotedEnds: (n: number) => '<img src="' + 'a>'.repeat(n) + '">',
    },
  },
  gallery: {
    path: galleryPath, functionName: 'resolveGalleryImageSourcesInHtml', normal: '<img class="portrait" src="gallery://portrait" style="width:42%">',
    fixtures: {
      missingEnds: (n: number) => '<img '.repeat(n) + 'src="a" '.repeat(n),
      outsideSources: (n: number) => 'src="a" '.repeat(n) + '<img src="gallery://portrait">' + 'src="a" '.repeat(n),
      failedSources: (n: number) => '<img '.repeat(n) + 'src="a\' '.repeat(n) + '>',
      repeatedSources: (n: number) => '<img ' + 'src="gallery://portrait" '.repeat(n) + '>',
      sourceSpaces: (n: number) => '<img src' + ' '.repeat(n) + '= "gallery://portrait">',
    },
  },
}
if (target && !(target in cases)) throw new Error(`Unknown benchmark target: ${target}`)
const results = []
for (const [name, group] of Object.entries(cases)) {
  if (target && target !== name) continue
  const resolve = loadBenchmarkFunction<ResolveAsset>(group.path, group.functionName, ref, globals)
  resolve(group.normal, assets)
  const fixtures: Record<string, (n: number) => string> = { normal: () => group.normal, plain: () => 'Ordinary message text.', ...group.fixtures }
  for (const [fixture, makeInput] of Object.entries(fixtures)) {
    const ordinary = fixture === 'normal' || fixture === 'plain'
    const rows = measureBenchmarkFixture(raw => resolve(raw, assets), makeInput, ordinary ? 100 : 1, ordinary ? [1] : undefined)
    results.push(...rows.map(row => ({ target: name, fixture, ...row })))
  }
}
console.log(JSON.stringify({ ref: ref ?? 'working tree', bun: Bun.version,
  method: 'Actual source resolvers and supplied asset map; excludes AST loading and initial helper loading. One ordinary-image warmup; up to three samples, ordinary input batches of 100. Adversarial inputs double from 128 to 8192. Stop each fixture after a batch exceeds 250 ms or accumulated measured time exceeds 1000 ms; limits apply between calls. Excludes Markdown rendering, DOM, layout and paint.', results }, null, 2))
