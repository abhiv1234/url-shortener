import { createServer, type Server } from 'node:http';
import { registry } from './metrics.js';

/** Minimal HTTP server so worker processes can expose /metrics and /health. */
export function startMetricsServer(
  port: number,
  isHealthy: () => boolean,
  onListening?: (port: number) => void,
): Server {
  const server = createServer((req, res) => {
    if (req.url === '/metrics') {
      registry
        .metrics()
        .then((body) => {
          res.writeHead(200, { 'content-type': registry.contentType });
          res.end(body);
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
      return;
    }

    if (req.url === '/health') {
      const healthy = isHealthy();
      res.writeHead(healthy ? 200 : 503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: healthy ? 'ok' : 'down' }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  server.listen(port, () => onListening?.(port));
  return server;
}
