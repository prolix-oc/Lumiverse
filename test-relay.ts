import { OpenAICompatibleProvider } from "./src/llm/providers/openai-compatible";

class TestProvider extends OpenAICompatibleProvider {
  name = "test";
  displayName = "Test";
  defaultUrl = "http://localhost:11434/v1";
  capabilities = { parameters: {} } as any;
}

async function run() {
  const provider = new TestProvider();
  
  const stream = provider.generateStream("burrito-2026", "http://localhost:11434/v1", {
    model: "chipotle-pepper/pepper-1",
    messages: [{ role: "user", content: "I want to order a burrito", name: "user" }],
  });

  for await (const chunk of stream) {
    console.log("Chunk:", chunk);
  }
}

run().catch(console.error);
