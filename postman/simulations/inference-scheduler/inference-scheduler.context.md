# Inference scheduler simulation

Created 2026-10-26 from the OpenAI-compatible wire format in
`src/services/embeddings.service.ts`. The fixture models embeddings only;
the provider-owner mock search could not access the local Postman session
(`SecItemCopyMatching failed -50`), so this uses a local contract-derived mock.

## Purpose

Exercise the real embedding HTTP client while local inference serializes calls
and preempts nested work. See `postman/mocks/inference-scheduler/default.js`.

## Execution

```sh
postman simulation run postman/simulations/inference-scheduler/inference-scheduler.sim.yaml --port 49485 --output ndjson --no-history > /tmp/inference-scheduler.ndjson 2> /tmp/inference-scheduler.err
```

After the `listening` event, in another terminal:

```sh
INFERENCE_SCHEDULER_SIMULATION_URL=http://127.0.0.1:49485/inference bun test --isolate src/services/embeddings.service.inference-scheduling.test.ts
```

Use the actual address from `listening` if the port changes. Stop the simulation
with Ctrl-C after checking its request events.

## Assumptions

- Localhost listeners and requests need sandbox permission in Codex; denied
  binding appears as `listen EPERM`. (observed 2026-10-26)
- The proxy keeps forwarding the slow fixture request after the client aborts.
  This proves client cancellation, admission recovery, and serialization;
  it cannot establish that a real provider stops GPU work on disconnect.
  (observed 2026-10-26)
- Start without an earlier slow request still active: the fixture reset returns
  409 while its previous handler is running. (observed 2026-10-26)

## Observations

<!-- begin:observations -->
2026-10-26: the inference member served every expected embedding request;
serialization and nested cancellation/recovery passed. No members were silent.
<!-- end:observations -->
