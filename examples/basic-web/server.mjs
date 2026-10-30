import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8080);
const server = createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (request.url === '/health') {
    response.end(JSON.stringify({ status: 'ok' }));
  } else if (request.url === '/') {
    response.end(JSON.stringify({ app: process.env.APP_NAME ?? 'DockSlate Node.js example', node: process.version }));
  } else {
    response.writeHead(404);
    response.end(JSON.stringify({ error: 'Not found' }));
  }
});

server.listen(port, '0.0.0.0', () => console.log(`Listening on port ${port}`));
process.on('SIGTERM', () => server.close(() => process.exit(0)));
