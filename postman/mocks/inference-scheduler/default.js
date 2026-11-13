// OpenAI-compatible embedding wire shape consumed by embeddings.service.ts.
// Control routes expose fixture activity; no external model or credentials are used.
const http = require('node:http');
let active = 0;
let peak = 0;
let started = 0;
let cancelled = 0;
http.createServer(async (req, res) => {
  const json = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.method === 'GET' && req.url === '/__metrics') {
    return json(200, { active, peak, started, cancelled });
  }
  if (req.method === 'POST' && req.url === '/__reset') {
    if (active) return json(409, { error: 'Requests still active' });
    peak = started = cancelled = 0;
    return json(200, {});
  }
  if (req.method !== 'POST' || req.url !== '/v1/embeddings') {
    return json(501, { error: 'Endpoint not modeled' });
  }
  const body = req.body;
  if (req.headers.authorization !== 'Bearer test-key') return json(401, { error: 'Missing fixture credential' });
  if (!body || !body.model || !Array.isArray(body.input)) return json(400, { error: 'Invalid embedding request' });
  started += 1;
  active += 1;
  peak = Math.max(peak, active);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    active -= 1;
  };
  const timer = setTimeout(() => {
    finish();
    json(200, { object: 'list', model: body.model, data: body.input.map((_, index) => ({
      object: 'embedding', index, embedding: [0.5, 0.25],
    })), usage: { prompt_tokens: body.input.length, total_tokens: body.input.length } });
  }, body.input.includes('slow') ? 2000 : 40);
  res.on('close', () => {
    if (!finished) cancelled += 1;
    clearTimeout(timer);
    finish();
  });
}).listen(process.env.PORT);
