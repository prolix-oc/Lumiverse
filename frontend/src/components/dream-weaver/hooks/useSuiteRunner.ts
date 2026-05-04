import { useCallback, useState } from "react";
import { dreamWeaverToolingApi } from "@/api/dream-weaver-tooling";

const SUITE_TOOLS = [
  "set_name",
  "set_appearance",
  "set_personality",
  "set_scenario",
  "set_first_message",
  "set_voice_guidance",
] as const;

type SuiteState = "idle" | "running" | "done" | "error";

export function useSuiteRunner(sessionId: string) {
  const [state, setState] = useState<SuiteState>("idle");
  const [queued, setQueued] = useState(0);
  const [total] = useState(SUITE_TOOLS.length);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const start = useCallback(async () => {
    setState("running");
    setQueued(0);
    setErrorMessage(null);

    try {
      const result = await dreamWeaverToolingApi.runSuite(sessionId);
      setQueued(result.queued);
      if (result.status === "error") {
        setErrorMessage(result.errorMessage ?? "Suite failed. Check the results below.");
        setState("error");
        return;
      }
      setState("done");
    } catch {
      setErrorMessage("Suite failed. Check the connection and try again.");
      setState("error");
    }
  }, [sessionId]);

  const reset = useCallback(() => {
    setState("idle");
    setQueued(0);
    setErrorMessage(null);
  }, []);

  return { state, queued, total, errorMessage, start, reset };
}
