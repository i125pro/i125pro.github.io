const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = path.join(__dirname, '..', '..');
const POSTS_DIR = path.join(ROOT, '_posts');
const PORT = 4567;

function pad(n) { return String(n).padStart(2, '0'); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slugify(str) {
  return str
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'post';
}

function listPosts() {
  const files = fs.readdirSync(POSTS_DIR).filter(f => f.endsWith('.md'));
  return files.map(filename => {
    const raw = fs.readFileSync(path.join(POSTS_DIR, filename), 'utf8');
    const fm = parseFrontMatter(raw);
    return {
      filename,
      title: fm.data.title || filename,
      lang: fm.data.lang || 'zh',
      body: fm.body,
    };
  }).sort((a, b) => b.filename.localeCompare(a.filename));
}

function parseFrontMatter(raw) {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { data: {}, body: raw };
  const [, fmBlock, body] = match;
  const data = {};
  fmBlock.split(/\r?\n/).forEach(line => {
    const m = line.match(/^([a-zA-Z_]+):\s*(.*)$/);
    if (!m) return;
    let [, key, val] = m;
    val = val.trim();
    if (/^".*"$/.test(val)) val = val.slice(1, -1);
    data[key] = val;
  });
  return { data, body: body.replace(/^\r?\n/, '') };
}

function buildFrontMatter({ title, lang, permalink }) {
  const escapedTitle = title.replace(/"/g, '\\"');
  let fm = `---\ntitle: "${escapedTitle}"\nlang: ${lang}\n`;
  if (permalink) fm += `permalink: ${permalink}\n`;
  fm += '---\n\n';
  return fm;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    serveStatic(res, path.join(__dirname, 'index.html'));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/posts') {
    try {
      sendJSON(res, 200, listPosts());
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/save') {
    try {
      const body = JSON.parse(await readBody(req));
      const { title, lang, content, filename: existingFilename } = body;
      if (!title || !content) {
        sendJSON(res, 400, { error: 'title 和 content 不能为空' });
        return;
      }
      let filename = existingFilename;
      let permalink = null;
      if (!filename) {
        const slug = slugify(title);
        const date = todayStr();
        filename = lang === 'en' ? `${date}-${slug}-en.md` : `${date}-${slug}.md`;
        if (lang === 'en') permalink = '/en/:year/:month/:day/:title/';
      }
      const fm = buildFrontMatter({ title, lang: lang || 'zh', permalink });
      fs.writeFileSync(path.join(POSTS_DIR, filename), fm + content.trim() + '\n', 'utf8');
      sendJSON(res, 200, { ok: true, filename });
    } catch (e) {
      sendJSON(res, 500, { error: e.message });
    }
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`博客编辑器已启动: http://localhost:${PORT}`);
});

