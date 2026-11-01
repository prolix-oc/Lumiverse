import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import LazyImage from '../src/components/shared/LazyImage'
import CachedImage from '../src/components/shared/CachedImage'
import HomepageLibraryCardImage from '../src/components/landing/HomepageLibraryCardImage'
import { rememberImageDecoded } from '../src/lib/imageDecodeCache'
import '../src/theme/global.css'
import landing from '../src/components/landing/LandingPage.module.css'

const src = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jwZkAAAAASUVORK5CYII='
const originalDecode = HTMLImageElement.prototype.decode
let release!: () => void
const gate = new Promise<void>(resolve => { release = resolve })
let decodeCalls = 0
HTMLImageElement.prototype.decode = async function() {
  await originalDecode.call(this)
  decodeCalls++
  await gate
}
const samples: number[][] = []
let sampling = true
function sample() {
  if (!sampling) return
  samples.push([...document.querySelectorAll('img')].map(image => Number(getComputedStyle(image).opacity)))
  if (samples.length < 120) requestAnimationFrame(sample)
}
Object.assign(window, { finishImageDecodes: release, imageRevealSamples: samples,
  imageRevealDecodeCalls: () => decodeCalls, stopImageRevealSamples: () => { sampling = false } })
rememberImageDecoded(src)
const scrolling = new URL(location.href).searchParams.get('scrolling') === 'true'
flushSync(() => createRoot(document.getElementById('root')!).render(
  <section className={landing.container} data-scrolling={scrolling ? '' : undefined}
    style={{ display: 'flex', flexDirection: 'row', gap: 16 }}>
    <div className={landing.cardImage} style={{ width: 100, height: 100 }}><LazyImage src={src} loading="eager" /></div>
    <div className={`${landing.cardTilt} ${landing.tilting}`}>
      <div className={`${landing.cardImage} ${landing.perspectiveStack}`} style={{ width: 100, height: 100 }}>
        <CachedImage className={landing.perspectiveLayer} src={src} loading="eager" width={100} height={100} />
      </div>
    </div>
    <div className={landing.cardImage} style={{ width: 100, height: 100 }}><HomepageLibraryCardImage src={src} alt="Library" /></div>
  </section>,
))
requestAnimationFrame(sample)
