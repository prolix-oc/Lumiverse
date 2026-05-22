import type { CouncilMember, CouncilMemberContext } from "lumiverse-spindle-types";
import type { LlmMessage } from "../../llm/types";
import type { RuntimeCouncilToolDefinition } from "./tool-runtime";
import { searchWeb } from "../web-search.service";

export interface HostCouncilToolExecutionInput {
  userId: string;
  tool: RuntimeCouncilToolDefinition;
  args: Record<string, unknown>;
  member: CouncilMember;
  memberContext?: CouncilMemberContext;
  contextMessages: LlmMessage[];
  timeoutMs: number;
  signal?: AbortSignal;
}

type HostCouncilToolExecutor = (input: HostCouncilToolExecutionInput) => Promise<string>;

const hostToolExecutors = new Map<string, HostCouncilToolExecutor>([
  [
    "web_search",
    async ({ userId, args }) => {
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) {
        throw new Error("Web Search requires a non-empty query");
      }

      const requestedCount = typeof args.result_count === "number"
        ? args.result_count
        : typeof args.result_count === "string"
          ? Number(args.result_count)
          : undefined;

      const result = await searchWeb(userId, query, requestedCount);
      return result.context;
    },
  ],
]);

export function registerHostCouncilTool(name: string, executor: HostCouncilToolExecutor): void {
  hostToolExecutors.set(name, executor);
}

export async function executeHostCouncilTool(input: HostCouncilToolExecutionInput): Promise<string> {
  const executor = hostToolExecutors.get(input.tool.name);
  if (!executor) {
    throw new Error(`Host council tool \"${input.tool.displayName}\" is not registered`);
  }
  return executor(input);
}
