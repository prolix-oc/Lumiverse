import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react'
import styles from './ComfyUIWorkflowGraph.module.css'
import { detectComfyWorkflowJsonFormat } from './workflow-state'
import {
  fitViewportToBounds,
  getGraphBounds,
  panViewport,
  resetViewport,
  type GraphBounds,
  type GraphViewport,
  zoomViewportAtPoint,
} from './graph-view'

export interface ComfyUIWorkflowGraphHandle {
  fitToGraph: () => void
  resetView: () => void
  zoomIn: () => void
  zoomOut: () => void
}

export interface ComfyUIWorkflowGraphProps {
  workflow: Record<string, any> | null
  workflowFormat: 'ui_workflow' | 'api_prompt' | undefined
  mappedNodeIds: string[]
  highlightNodeId?: string | null
  onNodeClick: (nodeId: string, classType: string, anchor: { x: number; y: number }) => void
}

interface GraphNode {
  id: string
  title: string
  nodeType: string
  x: number
  y: number
  rawNode: Record<string, any>
}

interface DisplayGraphNode extends GraphNode {
  renderX: number
  renderY: number
}

interface GraphEdge {
  id: string
  fromId: string
  toId: string
}

const NODE_WIDTH = 208
const NODE_HEIGHT = 84
const COLUMN_GAP = 260
const ROW_GAP = 140
const GRAPH_PADDING = 72
const ZOOM_STEP = 1.12

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function buildUiGraph(
  workflow: Record<string, any>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const rawNodes = Array.isArray(workflow.nodes) ? workflow.nodes : []
  const rawLinks = Array.isArray(workflow.links) ? workflow.links : []

  const nodes = rawNodes.map((node: any, index: number) => {
    const pos = Array.isArray(node?.pos) ? node.pos : null
    return {
      id: String(node.id),
      title: String(node.title || node.type || `Node ${index + 1}`),
      nodeType: String(node.type || 'Unknown'),
      x: Array.isArray(pos) && typeof pos[0] === 'number' ? pos[0] : (index % 3) * COLUMN_GAP,
      y: Array.isArray(pos) && typeof pos[1] === 'number' ? pos[1] : Math.floor(index / 3) * ROW_GAP,
      rawNode: isRecord(node) ? node : {},
    } satisfies GraphNode
  })

  const edges = rawLinks.flatMap((link: any) => {
    if (!Array.isArray(link) || link.length < 5) return []
    return [{
      id: `edge-${link[0]}`,
      fromId: String(link[1]),
      toId: String(link[3]),
    } satisfies GraphEdge]
  })

  return { nodes, edges }
}

function buildApiGraph(
  workflow: Record<string, any>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const entries = Object.entries(workflow).filter(([, node]) => isRecord(node))
  const nodes = entries.map(([nodeId, node], index) => ({
    id: nodeId,
    title: String((node as any).title || (node as any).class_type || `Node ${index + 1}`),
    nodeType: String((node as any).class_type || 'Unknown'),
    x: (index % 3) * COLUMN_GAP,
    y: Math.floor(index / 3) * ROW_GAP,
    rawNode: node as Record<string, any>,
  }))

  const edges: GraphEdge[] = []
  for (const [nodeId, node] of entries) {
    const inputs = isRecord((node as any).inputs) ? (node as any).inputs : {}
    for (const [inputName, value] of Object.entries(inputs)) {
      if (!Array.isArray(value) || value.length === 0) continue
      edges.push({
        id: `edge-${String(value[0])}-${nodeId}-${inputName}`,
        fromId: String(value[0]),
        toId: nodeId,
      })
    }
  }

  return { nodes, edges }
}

export const ComfyUIWorkflowGraph = forwardRef<ComfyUIWorkflowGraphHandle, ComfyUIWorkflowGraphProps>(
  function ComfyUIWorkflowGraph({
    workflow,
    workflowFormat,
    mappedNodeIds,
    highlightNodeId,
    onNodeClick,
  }, ref) {
    const containerRef = useRef<HTMLDivElement>(null)
    const dragStateRef = useRef<{ pointerId: number; x: number; y: number } | null>(null)
    const [viewport, setViewport] = useState<GraphViewport>({ x: GRAPH_PADDING, y: GRAPH_PADDING, scale: 1 })

    const mappedSet = useMemo(() => new Set(mappedNodeIds), [mappedNodeIds])
    const resolvedWorkflowFormat = useMemo(() => {
      const detectedFormat = detectComfyWorkflowJsonFormat(workflow)
      return detectedFormat === 'unknown' ? (workflowFormat ?? 'api_prompt') : detectedFormat
    }, [workflow, workflowFormat])

    const graph = useMemo(
      () => workflow
        ? resolvedWorkflowFormat === 'ui_workflow'
          ? buildUiGraph(workflow)
          : buildApiGraph(workflow)
        : { nodes: [], edges: [] },
      [resolvedWorkflowFormat, workflow],
    )

    const sourceBounds = useMemo(
      () => getGraphBounds(
        graph.nodes.map((node) => ({
          x: node.x,
          y: node.y,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        })),
      ),
      [graph.nodes],
    )

    const displayNodes = useMemo<DisplayGraphNode[]>(
      () => graph.nodes.map((node) => ({
        ...node,
        renderX: node.x - sourceBounds.minX + GRAPH_PADDING,
        renderY: node.y - sourceBounds.minY + GRAPH_PADDING,
      })),
      [graph.nodes, sourceBounds.minX, sourceBounds.minY],
    )

    const displayBounds = useMemo<GraphBounds>(
      () => getGraphBounds(
        displayNodes.map((node) => ({
          x: node.renderX,
          y: node.renderY,
          width: NODE_WIDTH,
          height: NODE_HEIGHT,
        })),
      ),
      [displayNodes],
    )

    const nodeById = useMemo(
      () => new Map(displayNodes.map((node) => [node.id, node])),
      [displayNodes],
    )

    const worldWidth = Math.max(displayBounds.maxX + GRAPH_PADDING, 1200)
    const worldHeight = Math.max(displayBounds.maxY + GRAPH_PADDING, 900)

    const fitToGraph = useCallback(() => {
      const element = containerRef.current
      if (!element) return
      setViewport(
        fitViewportToBounds(
          displayBounds,
          element.clientWidth,
          element.clientHeight,
          GRAPH_PADDING,
        ),
      )
    }, [displayBounds])

    const resetView = useCallback(() => {
      setViewport(resetViewport(displayBounds, GRAPH_PADDING))
    }, [displayBounds])

    const zoomBy = useCallback((factor: number) => {
      const element = containerRef.current
      if (!element) return
      const anchor = {
        x: element.clientWidth / 2,
        y: element.clientHeight / 2,
      }
      setViewport((current) => zoomViewportAtPoint(current, current.scale * factor, anchor))
    }, [])

    useImperativeHandle(ref, () => ({
      fitToGraph,
      resetView,
      zoomIn: () => zoomBy(ZOOM_STEP),
      zoomOut: () => zoomBy(1 / ZOOM_STEP),
    }), [fitToGraph, resetView, zoomBy])

    useEffect(() => {
      if (!workflow) return
      fitToGraph()
    }, [fitToGraph, workflow])

    if (!workflow) {
      return (
        <div className={styles.graphEmpty}>
          <p>No workflow loaded yet.</p>
        </div>
      )
    }

    return (
      <div
        ref={containerRef}
        className={styles.graphCanvas}
        onPointerDown={(event) => {
          if ((event.target as HTMLElement).closest('[data-graph-node="true"]')) return
          dragStateRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          if (!dragStateRef.current || dragStateRef.current.pointerId !== event.pointerId) return
          const deltaX = event.clientX - dragStateRef.current.x
          const deltaY = event.clientY - dragStateRef.current.y
          dragStateRef.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            y: event.clientY,
          }
          setViewport((current) => panViewport(current, deltaX, deltaY))
        }}
        onPointerUp={(event) => {
          if (dragStateRef.current?.pointerId === event.pointerId) {
            dragStateRef.current = null
            event.currentTarget.releasePointerCapture(event.pointerId)
          }
        }}
        onPointerLeave={(event) => {
          if (dragStateRef.current?.pointerId === event.pointerId && !event.currentTarget.hasPointerCapture(event.pointerId)) {
            dragStateRef.current = null
          }
        }}
        onWheel={(event) => {
          event.preventDefault()
          const rect = event.currentTarget.getBoundingClientRect()
          if (event.ctrlKey || event.metaKey) {
            const factor = event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP
            const anchor = {
              x: event.clientX - rect.left,
              y: event.clientY - rect.top,
            }
            setViewport((current) => zoomViewportAtPoint(current, current.scale * factor, anchor))
            return
          }

          setViewport((current) => panViewport(current, -event.deltaX, -event.deltaY))
        }}
      >
        <div className={styles.graphSurface}>
          <div
            className={styles.graphWorld}
            style={{
              width: `${worldWidth}px`,
              height: `${worldHeight}px`,
              transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
            }}
          >
            <svg
              className={styles.graphEdges}
              viewBox={`0 0 ${worldWidth} ${worldHeight}`}
              preserveAspectRatio="none"
            >
              {graph.edges.map((edge) => {
                const from = nodeById.get(edge.fromId)
                const to = nodeById.get(edge.toId)
                if (!from || !to) return null
                const startX = from.renderX + NODE_WIDTH
                const startY = from.renderY + NODE_HEIGHT / 2
                const endX = to.renderX
                const endY = to.renderY + NODE_HEIGHT / 2
                const midX = (startX + endX) / 2

                return (
                  <path
                    key={edge.id}
                    d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
                    className={styles.graphEdgePath}
                  />
                )
              })}
            </svg>

            {displayNodes.map((node) => {
              const isMapped = mappedSet.has(node.id)
              const isExecuting = highlightNodeId === node.id
              const classNames = [styles.graphNode]
              if (isMapped) classNames.push(styles.mapped)
              if (isExecuting) classNames.push(styles.executing)
              return (
                <button
                  key={node.id}
                  type="button"
                  data-graph-node="true"
                  className={classNames.join(' ')}
                  style={{
                    left: `${node.renderX}px`,
                    top: `${node.renderY}px`,
                    width: `${NODE_WIDTH}px`,
                    minHeight: `${NODE_HEIGHT}px`,
                  }}
                  onClick={(event) => {
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    onNodeClick(node.id, node.nodeType, {
                      x: rect.right,
                      y: rect.top,
                    })
                  }}
                  onPointerDown={(event) => {
                    event.stopPropagation()
                  }}
                  onPointerUp={(event) => {
                    event.stopPropagation()
                    const rect = event.currentTarget.getBoundingClientRect()
                    onNodeClick(node.id, node.nodeType, {
                      x: rect.right,
                      y: rect.top,
                    })
                  }}
                >
                  <span className={styles.graphNodeType}>{node.nodeType}</span>
                  <strong className={styles.graphNodeTitle}>{node.title}</strong>
                  <span className={styles.graphNodeMeta}>
                    {isMapped ? 'Mapped' : 'Workflow node'}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      </div>
    )
  },
)
