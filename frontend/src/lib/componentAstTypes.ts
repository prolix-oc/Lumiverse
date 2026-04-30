import type React from 'react'

export interface ComponentAstDiagnostic {
  message: string
  line?: number
  column?: number
}

export interface ComponentAstProgram {
  source: string
  functionName: string
  params: ComponentAstParams
  declarations: ComponentAstDeclaration[]
  returnNode: unknown
}

export type ComponentAstParams =
  | { kind: 'identifier'; name: string }
  | { kind: 'destructure'; bindings: ComponentAstBinding[] }

export interface ComponentAstBinding {
  local: string
  prop: string
}

export interface ComponentAstDeclaration {
  name: string
  init: unknown
}

export type SafePropPrimitive = string | number | boolean | null | undefined

export type SafePropValue =
  | SafePropPrimitive
  | SafePropPrimitive[]
  | Record<string, SafePropPrimitive>
  | SafeActionBinding

export interface SafeActionBinding {
  kind: 'action'
  path: string
}

export type SafeRenderNode =
  | { kind: 'text'; value: string }
  | {
      kind: 'element'
      tag: string
      props: Record<string, SafePropValue>
      children: SafeRenderNode[]
    }
  | { kind: 'fragment'; children: SafeRenderNode[] }

export interface RuntimeOverrideContext {
  props: Record<string, unknown>
  actions: Record<string, unknown>
}

export type TrustedOverrideComponent = React.ComponentType<Record<string, unknown>>
