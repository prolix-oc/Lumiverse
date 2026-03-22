import type { ToolRegistration } from "lumiverse-spindle-types";

function qualifiedName(extensionId: string, toolName: string): string {
  return `${extensionId}:${toolName}`;
}

class ToolRegistry {
  private tools = new Map<string, ToolRegistration>();

  register(tool: ToolRegistration): void {
    const key = qualifiedName(tool.extension_id, tool.name);
    this.tools.set(key, tool);
  }

  unregister(name: string, extensionId?: string): void {
    if (extensionId) {
      this.tools.delete(qualifiedName(extensionId, name));
    } else {
      // Legacy: try exact key first, then search by bare name
      if (this.tools.has(name)) {
        this.tools.delete(name);
      } else {
        for (const [key, tool] of this.tools) {
          if (tool.name === name) {
            this.tools.delete(key);
            break;
          }
        }
      }
    }
  }

  unregisterByExtension(extensionId: string): void {
    for (const [key, tool] of this.tools) {
      if (tool.extension_id === extensionId) {
        this.tools.delete(key);
      }
    }
  }

  getTool(name: string): ToolRegistration | undefined {
    // Try qualified name first (extensionId:toolName)
    const direct = this.tools.get(name);
    if (direct) return direct;

    // Fall back to searching by bare tool name (for built-in/DLC lookups)
    for (const tool of this.tools.values()) {
      if (tool.name === name) return tool;
    }
    return undefined;
  }

  /** Get tool by its fully qualified key (extensionId:name). No fallback. */
  getToolQualified(qualifiedKey: string): ToolRegistration | undefined {
    return this.tools.get(qualifiedKey);
  }

  getTools(): ToolRegistration[] {
    return Array.from(this.tools.values());
  }

  getCouncilTools(): ToolRegistration[] {
    return this.getTools().filter((t) => t.council_eligible);
  }

  getToolsByExtension(extensionId: string): ToolRegistration[] {
    return this.getTools().filter((t) => t.extension_id === extensionId);
  }

  /** Get the qualified key for a tool registration */
  getQualifiedName(tool: ToolRegistration): string {
    return qualifiedName(tool.extension_id, tool.name);
  }
}

export const toolRegistry = new ToolRegistry();
