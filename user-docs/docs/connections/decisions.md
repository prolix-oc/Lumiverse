# Decision models

Decision models answer structured questions about text or JSON: choose an option, score against an ordered rubric, or estimate the probability of yes. Spindle extensions can use these answers for routing, scene changes, and other features.

## Add a connection

1. Open **Connections → Decision Models**.
2. Select **New Connection** and give it a name.
3. Choose **OpenRouter**, **NanoGPT**, **TypeSafe**, or **Inception**. You can enter that provider's API key or use **Sign in with OpenRouter** / **Sign in with NanoGPT** with the provider's default API URL.
4. Select a model from the model picker or enter its exact ID. OpenRouter suggests `~typesafe/jev-latest`; NanoGPT suggests `typesafe/jev-latest`; TypeSafe suggests `jev-latest`; Inception suggests `mercury-decide`.
5. Enable **Set as default** if extensions should use this connection when they do not select one explicitly, then save or sign in. Sign-in creates the connection after you authorize it and stores the key securely. Cancelling before authorization creates no connection.

To replace a key on an existing OpenRouter or NanoGPT connection, edit it and use **Sign in**. Save any provider or API URL changes first. After signing in, save any other edits you made to the connection.

The API URL can remain blank for the provider's default. A custom URL should be a versioned base URL, such as `https://proxy.example/v1`. Changing the provider or endpoint clears the previous credential unless you enter a replacement key. **Remove saved API key** clears a stored key explicitly.

Saved model IDs remain available even when the provider's model picker no longer lists them. You can duplicate, reorder, edit, or delete connections independently of your chat model connections.

Inception uses its native `/v1/decisions` endpoint with your Inception API key. Its model picker lists catalog entries that declare `decisions` endpoint support, excluding Mercury chat models. Lumiverse supports Choice, Score and Noul questions; the image-assets and Box API remains specific to TypeSafe.

## Check the connection

**Test connection** checks access to the provider's model catalog and does not run a decision. NanoGPT returns its public catalog even for an invalid key, so use **Run sample decision** to verify that credential.

**Run sample decision (uses provider credits)** sends a small evaluation to the saved model. This checks that the selected model accepts the Decision protocol. Models that require another protocol, including Together's Tev1, are excluded from the picker.

## Memory Cortex candidate review

Candidate review is optional and off by default. Enable **Memory Cortex → Candidate review → Review memory candidates**, choose **Decision model**, and select your Decision connection to use it.

Set **Reviewer input limit (tokens)** to the effective limit of your deployed server, including any separate question-token limit. It defaults to 16,384. Cortex reserves headroom for tokenizer differences and splits candidates into smaller batches; if the server still reports a context overflow, Cortex retries smaller groups. Each group retains the complete passage and its candidates' evidence and canonical targets. If one candidate cannot fit, the chunk remains pending with guidance to reduce the memory chunk size or increase the server's context window and reviewer input limit.

Jev-compatible endpoints can enforce different context limits from the hosted model or the model catalog. Check the actual endpoint rather than assuming that quantization, a model name, or an advertised context window determines every request limit.

## Use from extensions

Grant an extension its **Decisions** permission in the Extensions panel when you want it to inspect or use these connections. Extensions receive the results without receiving your API key. This release supports text and JSON input. Each extension determines how probabilities and confidence affect its behavior.
