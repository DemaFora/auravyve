'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3085;

console.log('Starting minimal server on PORT:', PORT);
console.log('RAILWAY_ENVIRONMENT:', process.env.RAILWAY_ENVIRONMENT);
console.log('Node version:', process.version);

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    const htmlPath = path.join(__dirname, 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end(fs.readFileSync(htmlPath));
    } else {
      res.writeHead(200, {'Content-Type': 'text/html'});
      res.end('<h1>AuraVyve - minimal server running</h1>');
    }
  } else if (req.url === '/health') {
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify({ok: true, port: PORT}));
  } else {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('AuraVyve minimal server running on port', PORT);
});
