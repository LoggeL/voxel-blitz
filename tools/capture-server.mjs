import http from 'node:http';
import { staticHandler } from '../server/static.js';

const requestedPort = Number.parseInt(process.env.PORT, 10);
const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : 0;

const server = http.createServer(async (request, response) => {
  try {
    if (await staticHandler(request, response)) return;
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
  } catch (error) {
    if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    if (!response.writableEnded) response.end(error?.message || 'capture server error');
  }
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  console.log(`voxel-blitz listening on :${address.port}`);
});

function stop(signal) {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 2_000).unref();
  console.log(`[voxel-blitz-capture] ${signal} received, shutting down`);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));
