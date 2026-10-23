// Debug log receiver for the add-on: listens on 127.0.0.1:8777 (this machine
// only) and appends each log line the add-on posts to tools/live.log.
// Run: node tools/logserver.mjs
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), 'live.log');
http.createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.end();
  let body = '';
  req.on('data', c => { body += c; if (body.length > 200000) req.destroy(); });
  req.on('end', () => {
    for (const line of body.split('\n').filter(Boolean)) fs.appendFileSync(out, new Date().toISOString().slice(11, 23) + ' ' + line + '\n');
    res.end('ok');
  });
}).listen(8777, '127.0.0.1', () => console.log('log receiver on 127.0.0.1:8777 ->', out));
