let preferredWallpaperVideoCodec: 'h264' | 'hevc' | null = null

function supportsType(video: HTMLVideoElement, type: string): boolean {
  const result = video.canPlayType(type)
  return result === 'probably' || result === 'maybe'
}

export function getPreferredWallpaperVideoCodec(): 'h264' | 'hevc' {
  if (preferredWallpaperVideoCodec) return preferredWallpaperVideoCodec
  if (typeof document === 'undefined') return 'h264'

  const video = document.createElement('video')
  const supportsHevc =
    supportsType(video, 'video/mp4; codecs="hvc1.1.6.L93.B0"') ||
    supportsType(video, 'video/mp4; codecs="hev1.1.6.L93.B0"') ||
    supportsType(video, 'video/mp4; codecs="hvc1"') ||
    supportsType(video, 'video/mp4; codecs="hev1"')

  preferredWallpaperVideoCodec = supportsHevc ? 'hevc' : 'h264'
  return preferredWallpaperVideoCodec
}
