import styles from '../src/components/landing/LandingPage.module.css'
import { getPerspectiveLayerStyle } from '../src/lib/perspectiveLayerStyle'

const tilt = document.createElement('div')
tilt.id = 'tilt'
const card = document.createElement('div')
card.className = styles.card
const stack = document.createElement('div')
stack.className = `${styles.cardImage} ${styles.perspectiveStack}`
const image = document.createElement('img')
image.id = 'layer'
image.className = styles.perspectiveLayer
// Opaque background plus a subject ending at the bottom of its canvas.
image.src = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400"><rect width="300" height="400" fill="#364968"/><path d="M0 50H300M0 100H300M0 150H300M0 200H300M0 250H300M0 300H300M0 350H300" stroke="#7284a1"/><circle cx="150" cy="145" r="55" fill="#f4b9a4"/><path d="M65 400V260Q65 200 150 200Q235 200 235 260V400" fill="#db9ebf"/></svg>')}`
stack.append(image)
card.append(stack)
tilt.append(card)
document.body.append(tilt)

Object.assign(window, { cardParallaxFixture: {
  configure(width: number, index: number, total: number, intensity: number, mode: 'motion' | 'rest' | 'hover') {
    tilt.style.width = `${width}px`
    tilt.className = `${styles.cardTilt} ${mode === 'rest' ? '' : styles.tilting} ${mode === 'motion' ? styles.mobileMotionTilting : ''}`
    image.removeAttribute('style')
    for (const [key, value] of Object.entries(getPerspectiveLayerStyle(index, total, intensity, 140))) image.style.setProperty(key, String(value))
    return Number(image.style.getPropertyValue(mode === 'rest' ? '--layer-base-scale' : '--layer-hover-scale'))
  },
  setTilt(x: number, y: number) { tilt.style.setProperty('--pointer-x', String(x)); tilt.style.setProperty('--pointer-y', String(y)) },
} })
