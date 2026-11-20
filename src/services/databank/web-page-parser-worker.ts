import {
  parseWebPage,
  WebPageParseError,
  type ParsedWebPage,
  type WebPageParseErrorCode,
} from "./web-page-parser";

type ParseRequest = {
  type: "parse";
  requestId: string;
  html: string;
  url: string;
};

type WorkerResponse =
  | { type: "result"; requestId: string; result: ParsedWebPage }
  | {
      type: "error";
      requestId: string;
      error: string;
      code: WebPageParseErrorCode;
    };

self.onmessage = (event: MessageEvent<ParseRequest>) => {
  const message = event.data;
  if (!message || message.type !== "parse") return;

  try {
    const result = parseWebPage(message.html, message.url);
    postMessage({
      type: "result",
      requestId: message.requestId,
      result,
    } satisfies WorkerResponse);
  } catch (err) {
    postMessage({
      type: "error",
      requestId: message.requestId,
      error: err instanceof Error ? err.message : "Failed to parse page content",
      code: err instanceof WebPageParseError ? err.code : "parse_error",
    } satisfies WorkerResponse);
  }
};
