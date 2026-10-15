const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 8080);
const API_KEY = process.env.GOOGLE_CLOUD_VISION_API_KEY;
const MAX_IMAGE_BYTES = 7 * 1024 * 1024;
const MAX_BODY_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024;
const MIME_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.gz': 'application/gzip',
  '.html': 'text/html; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wasm': 'application/wasm'
};
const requestsByAddress = new Map();

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff'
  });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.setEncoding('utf8');
    request.on('data', chunk => {
      if (tooLarge) return;
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        tooLarge = true;
        body = '';
        reject(Object.assign(new Error('Image is too large. Choose a photo smaller than 7 MB.'), { statusCode: 413 }));
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(Object.assign(new Error('Invalid OCR request.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function allowOcrRequest(address) {
  const now = Date.now();
  const windowMs = 60_000;
  if (requestsByAddress.size >= 5000) {
    for (const [key, times] of requestsByAddress) {
      const active = times.filter(time => now - time < windowMs);
      if (active.length) requestsByAddress.set(key, active);
      else requestsByAddress.delete(key);
    }
    if (requestsByAddress.size >= 5000 && !requestsByAddress.has(address)) return false;
  }
  const recent = (requestsByAddress.get(address) || []).filter(time => now - time < windowMs);
  if (recent.length >= 10) return false;
  recent.push(now);
  requestsByAddress.set(address, recent);
  return true;
}

async function recognizeHandwriting(request, response) {
  if (!API_KEY) {
    sendJson(response, 503, { error: 'Google Cloud Vision is not configured. Set GOOGLE_CLOUD_VISION_API_KEY on the server.' });
    return;
  }
  if (!allowOcrRequest(request.socket.remoteAddress || 'unknown')) {
    sendJson(response, 429, { error: 'Too many OCR requests. Wait a minute and try again.' });
    return;
  }
  if (!request.headers['content-type']?.startsWith('application/json')) {
    sendJson(response, 415, { error: 'OCR requests must use application/json.' });
    return;
  }

  let image;
  try {
    ({ image } = await readJson(request));
  } catch (error) {
    if (!response.destroyed) sendJson(response, error.statusCode || 400, { error: error.message });
    return;
  }
  if (typeof image !== 'string' || !image || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image)) {
    sendJson(response, 400, { error: 'The uploaded image is invalid.' });
    return;
  }
  if (Buffer.byteLength(image, 'base64') > MAX_IMAGE_BYTES) {
    sendJson(response, 413, { error: 'Image is too large. Choose a photo smaller than 7 MB.' });
    return;
  }

  try {
    const visionResponse = await fetch('https://vision.googleapis.com/v1/images:annotate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': API_KEY
      },
      body: JSON.stringify({
        requests: [{
          image: { content: image },
          features: [{ type: 'DOCUMENT_TEXT_DETECTION' }]
        }]
      }),
      signal: AbortSignal.timeout(30_000)
    });
    const result = await visionResponse.json();
    if (!visionResponse.ok) {
      console.error('Google Cloud Vision request failed:', visionResponse.status, result.error?.message || 'Unknown provider error');
      sendJson(response, 502, { error: 'Google Cloud Vision could not read this image. Check the photo or try again.' });
      return;
    }
    const annotation = result.responses?.[0];
    if (annotation?.error) {
      console.error('Google Cloud Vision rejected the image:', annotation.error.message);
      sendJson(response, 422, { error: 'Google Cloud Vision could not read this image. Try a clearer photo.' });
      return;
    }
    sendJson(response, 200, { text: annotation?.fullTextAnnotation?.text || '' });
  } catch (error) {
    console.error('Google Cloud Vision is unavailable:', error.message);
    sendJson(response, 502, { error: 'Google Cloud Vision is unavailable. Check your internet connection and try again.' });
  }
}

function serveFile(request, response, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const filePath = path.resolve(ROOT, relativePath);
  if (!filePath.startsWith(`${ROOT}${path.sep}`) || filePath === __filename || relativePath.split(/[\\/]/).some(part => part.startsWith('.'))) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  fs.stat(filePath, (statError, stat) => {
    if (statError || !stat.isFile()) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'Content-Length': stat.size,
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

const server = http.createServer((request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/api/ocr') {
    if (request.method !== 'POST') {
      response.setHeader('Allow', 'POST');
      sendJson(response, 405, { error: 'Use POST to submit an image for OCR.' });
      return;
    }
    recognizeHandwriting(request, response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end();
    return;
  }
  serveFile(request, response, pathname);
});

server.listen(PORT, () => {
  console.log(`Revalida Mastery available at http://localhost:${PORT}`);
  if (!API_KEY) console.warn('Online handwriting OCR is not configured. Set GOOGLE_CLOUD_VISION_API_KEY and restart the server.');
});
