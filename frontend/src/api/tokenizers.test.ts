import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { createTokenizersApi, type TokenizersApiClient } from './tokenizers'

const post = mock((..._args: unknown[]) => Promise.resolve(undefined))
const client = {
  del: mock(),
  get: mock(),
  post,
  put: mock(),
} as unknown as TokenizersApiClient
const tokenizersApi = createTokenizersApi(client)

describe('tokenizersApi.countForModel', () => {
  beforeEach(() => {
    post.mockClear()
  })

  test('forwards the exact signal and timeout options as the third post argument', async () => {
    const signal = new AbortController().signal
    const options = { signal, timeout: 12_345 }
    const response = { token_count: 17, char_count: 68 }
    post.mockResolvedValueOnce(response)

    await expect(tokenizersApi.countForModel('model-a', 'content', options)).resolves.toEqual(response)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      '/tokenizers/count',
      { model_id: 'model-a', text: 'content' },
      options,
    )
  })

  test('preserves the response DTO and passes undefined options for two arguments', async () => {
    const response = { token_count: null, char_count: 7 }
    post.mockResolvedValueOnce(response)

    await expect(tokenizersApi.countForModel('model-b', 'example')).resolves.toEqual(response)
    expect(post).toHaveBeenCalledTimes(1)
    expect(post).toHaveBeenCalledWith(
      '/tokenizers/count',
      { model_id: 'model-b', text: 'example' },
      undefined,
    )
  })
})
