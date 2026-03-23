export interface ExpressionConfig {
  enabled: boolean
  defaultExpression: string
  mappings: Record<string, string> // label → image_id
}

export interface ExpressionSlot {
  label: string
  imageId: string
}

export type ExpressionDisplaySize = 'small' | 'medium' | 'large' | 'custom'

export const EXPRESSION_SIZE_PRESETS: Record<
  Exclude<ExpressionDisplaySize, 'custom'>,
  { width: number; height: number }
> = {
  small: { width: 160, height: 200 },
  medium: { width: 240, height: 300 },
  large: { width: 360, height: 450 },
}

export interface ExpressionDisplaySettings {
  enabled: boolean
  sizePreset: ExpressionDisplaySize
  customWidth: number
  customHeight: number
  minimized: boolean
  frameless: boolean
  clickThrough: boolean
  x: number
  y: number
  opacity: number
}

export const DEFAULT_EXPRESSION_DISPLAY: ExpressionDisplaySettings = {
  enabled: true,
  sizePreset: 'medium',
  customWidth: 240,
  customHeight: 300,
  minimized: false,
  frameless: true,
  clickThrough: false,
  x: -1,
  y: -1,
  opacity: 1,
}

export interface ExpressionChangedPayload {
  chatId: string
  characterId: string
  label: string
  imageId: string
}
