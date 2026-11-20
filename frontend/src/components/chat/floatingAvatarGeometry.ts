export const FLOATING_AVATAR_MIN_SIZE = 120
export const FLOATING_AVATAR_VIEWPORT_PAD = 12
export const FLOATING_AVATAR_DRAG_BAR_HEIGHT = 28

export interface FloatingAvatarSize {
  width: number
  height: number
}

export interface FloatingAvatarPosition {
  x: number
  y: number
}

export interface FloatingAvatarViewport {
  width: number
  height: number
}

export function getFloatingAvatarViewportMax(viewport: FloatingAvatarViewport) {
  return {
    maxW: Math.max(
      FLOATING_AVATAR_MIN_SIZE,
      viewport.width - FLOATING_AVATAR_VIEWPORT_PAD * 2,
    ),
    maxH: Math.max(
      FLOATING_AVATAR_MIN_SIZE,
      viewport.height - FLOATING_AVATAR_DRAG_BAR_HEIGHT - FLOATING_AVATAR_VIEWPORT_PAD * 2,
    ),
  }
}

export function clampFloatingAvatarPosition(
  position: FloatingAvatarPosition,
  size: FloatingAvatarSize,
  viewport: FloatingAvatarViewport,
): FloatingAvatarPosition {
  return {
    x: Math.max(
      FLOATING_AVATAR_VIEWPORT_PAD,
      Math.min(position.x, viewport.width - size.width - FLOATING_AVATAR_VIEWPORT_PAD),
    ),
    y: Math.max(
      FLOATING_AVATAR_VIEWPORT_PAD,
      Math.min(
        position.y,
        viewport.height - size.height - FLOATING_AVATAR_DRAG_BAR_HEIGHT - FLOATING_AVATAR_VIEWPORT_PAD,
      ),
    ),
  }
}

export function centerFloatingAvatar(
  size: FloatingAvatarSize,
  viewport: FloatingAvatarViewport,
): FloatingAvatarPosition {
  return clampFloatingAvatarPosition({
    x: Math.round((viewport.width - size.width) / 2),
    y: Math.round((viewport.height - size.height - FLOATING_AVATAR_DRAG_BAR_HEIGHT) / 2),
  }, size, viewport)
}
