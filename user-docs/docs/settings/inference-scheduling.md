# Local Inference Scheduling

Lumiverse can put the requests that share your local model hardware into one
queue. This is for machines where chat, embeddings, the Memory Cortex sidecar,
and image generation all reach the same GPU (or the same small pool of RAM).

Without scheduling, a long chat can be streaming a reply while the Memory Cortex
sidecar is extracting entities and the embedding model is indexing new chunks.
Those models load at the same time, and the machine starts swapping or the
provider runs out of VRAM. With scheduling enabled, one request uses the model
resource at a time and everything else waits its turn.

Scheduling is **off by default** and only applies to **local** endpoints
(loopback addresses, private network hosts, and `.local`/`localhost` names).
Requests to hosted APIs are never delayed.

## Enable it

1. Open **Settings → Inference**.
2. Turn on **Local Inference Scheduling**.
3. Leave **One queue for all local endpoints** on if chat, embeddings, and image
   generation run on the same computer.
4. Leave **Concurrent requests per queue** at `1` for a single GPU.

The **Detected endpoints** list shows every chat, embedding, image, and Memory
Cortex connection that points at a local address. Toggle **Exclude** on any
endpoint that should keep running outside the queue.

## How the queue behaves

Requests are ordered by what the user is waiting for:

| Priority | Work |
| --- | --- |
| 1 | Chat replies, regeneration, edit-and-send |
| 2 | Image generation and Visual Studio jobs you requested |
| 3 | Retrieval for the next prompt |
| 4 | Memory Cortex extraction, summaries, cortex warming |
| 5 | Chunk and world-book embedding, backfills |

- A chat reply or a requested image can interrupt background extraction or
  batch embedding. Interrupted batches are retried later; interrupted Memory
  Cortex calls fall back to heuristics and the next chunk tries the sidecar
  again.
- Chat replies never give up while queued. Background work stops waiting after
  **Give up waiting after** seconds (0 means wait indefinitely).
- Long waits are promoted so background work cannot starve behind a constant
  stream of higher-priority requests.

If two requests are equally important, the one that arrived first runs first.

## Settings

| Setting | Meaning |
| --- | --- |
| **One queue for all local endpoints** | Every detected local endpoint shares one queue. Turn off to give each endpoint its own queue. |
| **Let chat and images interrupt background work** | Background extraction and embedding stop when interactive work needs the model. |
| **Concurrent requests per queue** | Keep at 1 for one GPU. Raise only for CPU endpoints or endpoints with memory headroom. |
| **Give up waiting after** | Maximum queue wait for background work. Chat is unaffected. |
| **Detected endpoints** | Include or exclude individual connections. |

## Live status

The **Live queue status** panel shows which request currently holds each queue,
which requests are waiting, and how long they have waited. Counters track
completed, preempted, and abandoned requests. The panel updates live over the
WebSocket and still polls every three seconds as a fallback while it is open.

## Limitations

- Only calls made by Lumiverse itself are scheduled. A Spindle extension that
  registers its own sidecar provider and contacts a model directly is outside
  the queue.
- Per-user settings are applied per account. On a multi-user server, enable
  scheduling for every account that shares the hardware.
- Scheduling starts and stops requests; it does not unload a model from VRAM.
  Use the model server's own idle-unload setting (for example Ollama's
  `keep_alive`) if you need memory released between requests.
- Requests that were already running when you change the settings finish on
  their previous queue.

## Troubleshooting

- **Nothing appears in the endpoint list** — the connection's URL is not local.
  Add it to **Extra origins** if it lives on another machine you still want
  queued.
- **Chat waits too long** — raise the image/chat priority order by enabling
  interruption, or split unrelated endpoints into their own queues by turning
  off the unified pool.
- **Embedding backlog grows during long chats** — that is expected; batch
  embedding resumes when the reply finishes. Lower the queue's maximum wait if
  you would rather it fail and retry sooner.
