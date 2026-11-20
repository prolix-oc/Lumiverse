import react, { reactCompilerPreset } from '@vitejs/plugin-react'
import babel from '@rolldown/plugin-babel'

const include = [
  /\.tsx$/,
  /src\/hooks\/[^/]+\.ts$/,
  /src\/store\/index\.ts$/,
  /src\/ws\/useWebSocket\.ts$/,
  /src\/lib\/dndUiScale\.ts$/,
  /src\/lib\/oocAvatarLookup\.ts$/,
  /src\/lib\/wallpaperVideoCache\.ts$/,
  /src\/lib\/i18n\/worldBookEntryLabels\.ts$/,
  /src\/lib\/i18n\/loomOptionLabels\.ts$/,
  /src\/lib\/spindle\/components-helper\.tsx$/,
]
const exclude = [/node_modules/, /src\/lib\/generated(?:ComponentCss|ComponentProps|CssVariables)\.ts$/]

/** Both implementations retain explicit per-function compilation annotations. */
export function createReactCompilerPlugins(mode = process.env.LUMIVERSE_REACT_COMPILER ?? 'native') {
  if (mode === 'native') {
    return react({
      compiler: { target: '19', compilationMode: 'annotation', logDiagnostics: true },
      include,
      exclude,
    })
  }
  if (mode !== 'babel') throw new Error(`Unknown LUMIVERSE_REACT_COMPILER: ${mode}. Use babel or native.`)

  return [
    babel({
      presets: [reactCompilerPreset({ target: '19', compilationMode: 'annotation' })],
      include,
      exclude,
    }),
    react(),
  ]
}
