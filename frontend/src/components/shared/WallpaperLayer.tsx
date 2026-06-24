import { useEffect, useRef, useState, type RefObject } from 'react'
import { imagesApi } from '@/api/images'
import type { WallpaperRef, WallpaperSettings } from '@/types/store'
import styles from './WallpaperLayer.module.css'

const MAX_WALLPAPER_IMAGE_BLUR_PX = 8

interface WallpaperLayerProps {
  wallpaper: WallpaperRef | null
  settings: Pick<WallpaperSettings, 'opacity' | 'fit' | 'blur'>
  hidden?: boolean
  fixed?: boolean
  fadeInOnMount?: boolean
  videoRef?: RefObject<HTMLVideoElement | null>
}

export default function WallpaperLayer({ wallpaper, settings, hidden = false, fixed = false, fadeInOnMount = false, videoRef }: WallpaperLayerProps) {
  const [fadeReady, setFadeReady] = useState(!fadeInOnMount)
  const revealRef = useRef(() => setFadeReady(true))
  const ownedVideoRef = useRef<HTMLVideoElement>(null)
  const activeVideoRef = videoRef ?? ownedVideoRef

  useEffect(() => {
    if (!fadeInOnMount || !wallpaper?.image_id) {
      setFadeReady(true)
      revealRef.current = () => setFadeReady(true)
      return
    }

    setFadeReady(false)
    let cancelled = false
    let raf = 0
    const fallback = window.setTimeout(() => reveal(), 1200)

    const reveal = () => {
      if (cancelled) return
      if (raf) window.cancelAnimationFrame(raf)
      raf = window.requestAnimationFrame(() => setFadeReady(true))
    }
    revealRef.current = reveal

    if (wallpaper.type === 'image') {
      const image = new Image()
      image.onload = reveal
      image.onerror = reveal
      image.src = imagesApi.url(wallpaper.image_id)
    }

    return () => {
      cancelled = true
      window.clearTimeout(fallback)
      if (raf) window.cancelAnimationFrame(raf)
    }
  }, [fadeInOnMount, wallpaper?.image_id, wallpaper?.type])

  useEffect(() => {
    if (wallpaper?.type !== 'video') return

    const video = activeVideoRef.current
    if (!video) return

    const syncPlayback = () => {
      if (hidden || document.hidden) {
        video.pause()
        return
      }
      void video.play().catch(() => {})
    }

    syncPlayback()
    document.addEventListener('visibilitychange', syncPlayback)
    return () => {
      document.removeEventListener('visibilitychange', syncPlayback)
      video.pause()
    }
  }, [activeVideoRef, hidden, wallpaper?.image_id, wallpaper?.type])

  if (!wallpaper?.image_id) return null

  const url = imagesApi.url(wallpaper.image_id)
  const opacity = hidden || !fadeReady ? 0 : settings.opacity ?? 0.3
  const fit = settings.fit ?? 'cover'
  const requestedBlur = Math.max(0, settings.blur ?? 0)
  const blur = wallpaper.type === 'video' ? 0 : Math.min(requestedBlur, MAX_WALLPAPER_IMAGE_BLUR_PX)
  const filter = blur > 0 ? `blur(${blur}px)` : undefined

  const className = fixed ? `${styles.layer} ${styles.fixed}` : styles.layer
  const videoClassName = fixed ? `${styles.videoLayer} ${styles.fixed}` : styles.videoLayer

  if (wallpaper.type === 'video') {
    return (
      <video
        ref={activeVideoRef}
        key={wallpaper.image_id}
        className={videoClassName}
        src={url}
        autoPlay
        muted
        loop
        playsInline
        preload="auto"
        onLoadedData={fadeInOnMount ? () => revealRef.current() : undefined}
        onError={fadeInOnMount ? () => revealRef.current() : undefined}
        style={{
          opacity,
          objectFit: fit === 'fill' ? 'fill' : fit,
          filter,
        }}
      />
    )
  }

  return (
    <div
      className={className}
      style={{
        backgroundImage: `url("${url}")`,
        opacity,
        backgroundSize: fit === 'fill' ? '100% 100%' : fit,
        filter,
      }}
    />
  )
}
