const http = require('http');

const PORT = 3000;
const REQUESTS = 100;

const server = http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, {'Content-Type': 'text/plain'});
    res.end('pong');
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Test server running on http://127.0.0.1:${PORT}`);
  let completed = 0;
  let totalTime = 0;
  for (let i = 0; i < REQUESTS; i++) {
    const start = Date.now();
    http.get(`http://127.0.0.1:${PORT}/ping`, res => {
      res.on('data', () => {});
      res.on('end', () => {
        totalTime += Date.now() - start;
        completed++;
        if (completed === REQUESTS) {
          console.log(`Average response time: ${totalTime / REQUESTS}ms`);
          server.close();
        }
      });
    }).on('error', err => {
      console.error('Request failed:', err.message);
      completed++;
      if (completed === REQUESTS) {
        console.log(`Average response time: ${totalTime / REQUESTS}ms`);
        server.close();
      }
    });
  }
});
