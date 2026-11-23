import { afterEach, describe, expect, it, vi } from 'vitest';
import handler from '../../api/master-ia/v1/chat/completions.js';

function createResponse() {
  const headers = new Map();
  const res = {
    statusCode: 200,
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    send(body) {
      res.body = body;
      return res;
    },
    json(body) {
      res.body = body;
      return res;
    },
    end(body) {
      res.body = body;
      return res;
    },
  };
  res.headers = headers;
  return res;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MASTER_IA_UPSTREAM_URL;
});

describe('Master IA API proxy', () => {
  it('answers OPTIONS with CORS headers', async () => {
    const res = createResponse();

    await handler(
      {
        method: 'OPTIONS',
        headers: { origin: 'https://masterwhats.recomendeme.com.br' },
      },
      res,
    );

    expect(res.statusCode).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'https://masterwhats.recomendeme.com.br',
    );
    expect(res.headers.get('access-control-allow-methods')).toBe('POST, OPTIONS');
  });

  it('forwards POST bodies and returns upstream SSE content', async () => {
    process.env.MASTER_IA_UPSTREAM_URL = 'https://inference.example/v1/chat/completions';
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      text: vi.fn().mockResolvedValue('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n'),
    });
    vi.stubGlobal('fetch', fetchMock);
    const res = createResponse();

    await handler(
      {
        method: 'POST',
        headers: { origin: 'https://www.masterwhats.com.br' },
        body: { model: 'gpt-oss:20b', stream: true },
      },
      res,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://inference.example/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'gpt-oss:20b', stream: true }),
      }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.body).toContain('"content":"ok"');
  });
});
