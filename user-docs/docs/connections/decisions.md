# Decision models

Decision models answer structured questions about text or JSON: choose an option, score against an ordered rubric, or estimate the probability of yes. Spindle extensions can use these answers for routing, scene changes, and other features.

## Add a connection

1. Open **Connections → Decision Models**.
2. Select **New Connection** and give it a name.
3. Choose **OpenRouter** or **TypeSafe** and enter that provider's API key.
4. Select a model from the model picker or enter its exact ID. OpenRouter suggests `~typesafe/jev-latest`; TypeSafe suggests `jev-latest`.
5. Enable **Set as default** if extensions should use this connection when they do not select one explicitly, then save.

The API URL can remain blank for the provider's default. A custom URL should be a versioned base URL, such as `https://proxy.example/v1`. Changing the provider or endpoint clears the previous credential unless you enter a replacement key. **Remove saved API key** clears a stored key explicitly.

Saved model IDs remain available even when the provider's model picker no longer lists them. You can duplicate, reorder, edit, or delete connections independently of your chat model connections.

## Check the connection

**Test connection** checks your API key and access to the provider's model catalog. It does not run a decision.

**Run sample decision (uses provider credits)** sends a small evaluation to the saved model. This checks that the selected model accepts the Decision protocol. Models that require another protocol, including Together's Tev1, are excluded from the picker.

## Use from extensions

Grant an extension its **Decisions** permission in the Extensions panel when you want it to inspect or use these connections. Extensions receive the results without receiving your API key. This release supports text and JSON input. Each extension determines how probabilities and confidence affect its behavior.
