import { OpenAICompatibleProvider } from "./openai-compatible";
import { COMMON_PARAMS, type ProviderCapabilities } from "../param-schema";

/**
 * Amazon Bedrock via its OpenAI-compatible endpoints.
 *
 * Bedrock now exposes standard `/v1/chat/completions` and `/v1/models` APIs
 * authenticated with a plain bearer token — an "Amazon Bedrock API key" (a
 * long- or short-term credential minted in the Bedrock console / IAM). That
 * means it slots straight into the OpenAI-compatible base class with no AWS
 * SigV4 request signing and no AWS SDK dependency: auth is just
 * `Authorization: Bearer <key>`, exactly like OpenAI.
 *
 * The effective host is derived per-connection from `metadata.region` and the
 * `metadata.bedrock_endpoint` toggle by `resolveEffectiveApiUrl()` in
 * connections.service.ts:
 *   - mantle  (default, AWS-recommended, broadest catalog):
 *       https://bedrock-mantle.{region}.api.aws/v1
 *   - runtime (supports cross-region inference profiles, e.g. us.anthropic.*):
 *       https://bedrock-runtime.{region}.amazonaws.com/v1
 *
 * Both speak the OpenAI wire format (streaming SSE deltas, tool calls) and
 * accept the same bearer token, so `generate`/`generateStream`/`validateKey`/
 * `listModels` are all inherited unchanged. Model IDs are Bedrock's own
 * (e.g. `openai.gpt-oss-120b`, `us.anthropic.claude-sonnet-4-6`), discovered
 * via the `/models` endpoint.
 */
export class BedrockProvider extends OpenAICompatibleProvider {
  readonly name = "bedrock";
  readonly displayName = "Amazon Bedrock";
  // Fallback host used for the provider listing's `default_url` and previews
  // before a region is chosen; the real host is computed per-connection from
  // metadata via resolveEffectiveApiUrl().
  readonly defaultUrl = "https://bedrock-mantle.us-east-1.api.aws/v1";

  readonly capabilities: ProviderCapabilities = {
    parameters: {
      temperature: { ...COMMON_PARAMS.temperature, max: 2 },
      max_tokens: COMMON_PARAMS.max_tokens,
      top_p: COMMON_PARAMS.top_p,
      top_k: COMMON_PARAMS.top_k,
      frequency_penalty: COMMON_PARAMS.frequency_penalty,
      presence_penalty: COMMON_PARAMS.presence_penalty,
      stop: COMMON_PARAMS.stop,
    },
    requiresMaxTokens: false,
    supportsSystemRole: true,
    supportsStreaming: true,
    apiKeyRequired: true,
    modelListStyle: "openai",
  };
}
