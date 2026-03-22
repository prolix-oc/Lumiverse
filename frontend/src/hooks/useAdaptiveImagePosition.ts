import { useState, useEffect, useRef } from 'react'

export function useAdaptiveImagePosition(imageUrl: string) {
  const [state, setState] = useState({
    objectPosition: 'center center',
    isLoaded: false,
    isPortrait: false,
    isSquare: false,
    isLandscape: false,
  })

  const currentUrlRef = useRef(imageUrl)

  useEffect(() => {
    currentUrlRef.current = imageUrl

    if (!imageUrl) {
      setState({
        objectPosition: 'center center',
        isLoaded: false,
        isPortrait: false,
        isSquare: false,
        isLandscape: false,
      })
      return
    }

    const img = new Image()

    img.onload = () => {
      if (currentUrlRef.current !== imageUrl) return

      const { naturalWidth: width, naturalHeight: height } = img
      const aspectRatio = width / height

      const isSquare = aspectRatio >= 0.9 && aspectRatio <= 1.1
      const isPortrait = aspectRatio < 0.9
      const isLandscape = aspectRatio > 1.1

      let objectPosition = 'center center'
      if (isPortrait) {
        objectPosition = 'center 20%'
      }

      setState({ objectPosition, isLoaded: true, isPortrait, isSquare, isLandscape })
    }

    img.onerror = () => {
      if (currentUrlRef.current !== imageUrl) return
      setState({
        objectPosition: 'center center',
        isLoaded: false,
        isPortrait: false,
        isSquare: false,
        isLandscape: false,
      })
    }

    img.src = imageUrl

    return () => {
      img.onload = null
      img.onerror = null
    }
  }, [imageUrl])

  return state
}
