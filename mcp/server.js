#!/usr/bin/env node
'use strict';

/**
 * Workspace Context MCP Server
 * Provides tools for reading and writing per-project context entries,
 * including text notes, local files, and URLs.
 * Usage: node server.js --store /path/to/context.json
 */

const fs       = require('fs');
const path     = require('path');
const readline = require('readline');
const https    = require('https');
const http     = require('http');

// ─── Args ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const storeIdx = args.indexOf('--store');
if (storeIdx === -1 || !args[storeIdx + 1]) {
  process.stderr.write('workspace-context MCP: --store <path> required\n');
  process.exit(1);
}
const STORE_PATH = args[storeIdx + 1];

// ─── Store ────────────────────────────────────────────────────────────────────

function load() {
  try {
    if (fs.existsSync(STORE_PATH)) return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (_) {}
  return { entries: [] };
}

function save(store) {
  fs.mkdirSync(path.dirname(STORE_PATH), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

// ─── URL fetcher ──────────────────────────────────────────────────────────────

function fetchUrl(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    if (redirects === 0) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'workspace-context-mcp/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, url).href;
        return fetchUrl(next, redirects - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        body: Buffer.concat(chunks).toString('utf8'),
        contentType: res.headers['content-type'] || '',
      }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g,  '&')
    .replace(/&lt;/g,   '<')
    .replace(/&gt;/g,   '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g,  "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ─── Protocol helpers ─────────────────────────────────────────────────────────

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

function textResult(text, isError = false) {
  const r = { content: [{ type: 'text', text }] };
  if (isError) r.isError = true;
  return r;
}

// ─── Entry rendering ──────────────────────────────────────────────────────────

function renderEntry(e) {
  const header = `## [${e.id}] ${e.title}\n**Type:** ${e.type}  |  **Updated:** ${e.updatedAt.slice(0, 10)}`;

  if (e.type === 'file') {
    const fp = e.path;
    try {
      const content = fs.readFileSync(fp, 'utf8');
      const ext = path.extname(fp).slice(1) || 'text';
      return `${header}\n**Path:** ${fp}\n\n\`\`\`${ext}\n${content}\n\`\`\``;
    } catch (err) {
      return `${header}\n**Path:** ${fp}\n\n⚠️ Could not read file: ${err.message}`;
    }
  }

  if (e.type === 'url') {
    return `${header}\n**URL:** ${e.url}\n\n*(Call fetch_url_context with id "${e.id}" to load current content)*`;
  }

  return `${header}\n\n${e.content}`;
}

// ─── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'list_context',
    description: 'List all context entries — notes, files, and URLs — with their IDs and types.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_context',
    description: 'Get full content of one or all entries. File entries are read from disk live. URL entries show the URL (use fetch_url_context to load).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Entry ID. Omit to retrieve all.' },
      },
    },
  },
  {
    name: 'fetch_url_context',
    description: 'Fetch the current content of a URL context entry from the web and return its text.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string', description: 'ID of the URL context entry to fetch.' },
      },
    },
  },
  {
    name: 'add_context',
    description: 'Add a text-based context entry (note, spec, doc, code snippet, decision, etc.).',
    inputSchema: {
      type: 'object',
      required: ['title', 'content'],
      properties: {
        title:   { type: 'string', description: 'Short descriptive title' },
        content: { type: 'string', description: 'Content (markdown supported)' },
        type:    { type: 'string', enum: ['note', 'spec', 'doc', 'code', 'decision', 'other'] },
      },
    },
  },
  {
    name: 'add_file_context',
    description: 'Register a local file path as a context entry. Its content will be read fresh each time get_context is called.',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path:  { type: 'string', description: 'Absolute path to the file' },
        title: { type: 'string', description: 'Optional display title (defaults to filename)' },
      },
    },
  },
  {
    name: 'add_url_context',
    description: 'Register a URL as a context entry. Use fetch_url_context to load its current content.',
    inputSchema: {
      type: 'object',
      required: ['url'],
      properties: {
        url:   { type: 'string', description: 'Full URL including https://' },
        title: { type: 'string', description: 'Optional display title (defaults to URL)' },
      },
    },
  },
  {
    name: 'update_context',
    description: 'Update the title, content, or type of an existing text context entry.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id:      { type: 'string' },
        title:   { type: 'string' },
        content: { type: 'string' },
        type:    { type: 'string', enum: ['note', 'spec', 'doc', 'code', 'decision', 'other'] },
      },
    },
  },
  {
    name: 'delete_context',
    description: 'Remove a context entry.',
    inputSchema: {
      type: 'object',
      required: ['id'],
      properties: {
        id: { type: 'string' },
      },
    },
  },
  {
    name: 'search_context',
    description: 'Search context entries by keyword (title and text content; not file/URL content).',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
      },
    },
  },
];

// ─── Async tool handler (for URL fetching) ────────────────────────────────────

async function handleTool(name, toolArgs, id) {
  const store = load();

  // ── list_context ──────────────────────────────────────────────────────────
  if (name === 'list_context') {
    if (!store.entries.length) return reply(id, textResult('No context entries yet.'));
    const lines = store.entries.map(e => {
      const typeTag = (e.type || 'note').padEnd(8);
      const detail  = e.type === 'file' ? e.path : e.type === 'url' ? e.url : '';
      return `[${e.id}] [${typeTag}] ${e.title}${detail ? `  → ${detail}` : ''}`;
    });
    return reply(id, textResult(lines.join('\n')));
  }

  // ── get_context ───────────────────────────────────────────────────────────
  if (name === 'get_context') {
    const entries = toolArgs.id
      ? store.entries.filter(e => e.id === toolArgs.id)
      : store.entries;
    if (!entries.length) {
      return reply(id, textResult(toolArgs.id ? `No entry with id "${toolArgs.id}".` : 'No context entries yet.'));
    }
    const text = entries.map(renderEntry).join('\n\n---\n\n');
    return reply(id, textResult(text));
  }

  // ── fetch_url_context ─────────────────────────────────────────────────────
  if (name === 'fetch_url_context') {
    const entry = store.entries.find(e => e.id === toolArgs.id);
    if (!entry) return reply(id, textResult(`No entry with id "${toolArgs.id}".`, true));
    if (entry.type !== 'url') return reply(id, textResult(`Entry "${entry.title}" is type "${entry.type}", not a URL.`, true));
    try {
      const { body, contentType } = await fetchUrl(entry.url);
      const isHtml = contentType.includes('html');
      const text   = isHtml ? stripHtml(body) : body;
      const MAX    = 80000;
      const out    = text.length > MAX ? text.slice(0, MAX) + `\n\n…(truncated at ${MAX} chars)` : text;
      return reply(id, textResult(`# ${entry.title}\nSource: ${entry.url}\n\n${out}`));
    } catch (err) {
      return reply(id, textResult(`Failed to fetch ${entry.url}: ${err.message}`, true));
    }
  }

  // ── add_context ───────────────────────────────────────────────────────────
  if (name === 'add_context') {
    const entry = {
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title:     toolArgs.title,
      content:   toolArgs.content,
      type:      toolArgs.type || 'note',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.entries.push(entry);
    save(store);
    return reply(id, textResult(`Added "${entry.title}" (id: ${entry.id})`));
  }

  // ── add_file_context ──────────────────────────────────────────────────────
  if (name === 'add_file_context') {
    const fp = toolArgs.path;
    if (!fs.existsSync(fp)) return reply(id, textResult(`File not found: ${fp}`, true));
    const entry = {
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title:     toolArgs.title || path.basename(fp),
      path:      fp,
      type:      'file',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.entries.push(entry);
    save(store);
    return reply(id, textResult(`Added file context "${entry.title}" (id: ${entry.id})`));
  }

  // ── add_url_context ───────────────────────────────────────────────────────
  if (name === 'add_url_context') {
    const entry = {
      id:        Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      title:     toolArgs.title || toolArgs.url,
      url:       toolArgs.url,
      type:      'url',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    store.entries.push(entry);
    save(store);
    return reply(id, textResult(`Added URL context "${entry.title}" (id: ${entry.id})`));
  }

  // ── update_context ────────────────────────────────────────────────────────
  if (name === 'update_context') {
    const entry = store.entries.find(e => e.id === toolArgs.id);
    if (!entry) return reply(id, textResult(`No entry with id "${toolArgs.id}".`, true));
    if (toolArgs.title   !== undefined) entry.title   = toolArgs.title;
    if (toolArgs.content !== undefined) entry.content = toolArgs.content;
    if (toolArgs.type    !== undefined) entry.type    = toolArgs.type;
    entry.updatedAt = new Date().toISOString();
    save(store);
    return reply(id, textResult(`Updated "${entry.title}".`));
  }

  // ── delete_context ────────────────────────────────────────────────────────
  if (name === 'delete_context') {
    const idx = store.entries.findIndex(e => e.id === toolArgs.id);
    if (idx === -1) return reply(id, textResult(`No entry with id "${toolArgs.id}".`, true));
    const [removed] = store.entries.splice(idx, 1);
    save(store);
    return reply(id, textResult(`Deleted "${removed.title}".`));
  }

  // ── search_context ────────────────────────────────────────────────────────
  if (name === 'search_context') {
    const q = toolArgs.query.toLowerCase();
    const matches = store.entries.filter(e => {
      const inTitle   = e.title.toLowerCase().includes(q);
      const inContent = e.content && e.content.toLowerCase().includes(q);
      const inPath    = e.path && e.path.toLowerCase().includes(q);
      const inUrl     = e.url  && e.url.toLowerCase().includes(q);
      return inTitle || inContent || inPath || inUrl;
    });
    if (!matches.length) return reply(id, textResult(`No entries matching "${toolArgs.query}".`));
    const text = matches.map(e => {
      const preview = e.content ? e.content.slice(0, 150) + (e.content.length > 150 ? '…' : '') : (e.path || e.url || '');
      return `[${e.id}] [${e.type}] ${e.title}\n${preview}`;
    }).join('\n\n---\n\n');
    return reply(id, textResult(text));
  }

  replyError(id, -32601, `Unknown tool: ${name}`);
}

// ─── Main loop ────────────────────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', line => {
  line = line.trim();
  if (!line) return;
  let msg;
  try { msg = JSON.parse(line); } catch (_) { return; }

  const { id, method, params } = msg;

  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'workspace-context', version: '2.0.0' },
    });
  }

  if (method === 'notifications/initialized') return;

  if (method === 'tools/list') return reply(id, { tools: TOOLS });

  if (method === 'tools/call') {
    // handleTool is async (for URL fetching) — errors must be caught
    handleTool(params.name, params.arguments || {}, id)
      .catch(err => replyError(id, -32603, err.message));
    return;
  }

  replyError(id, -32601, `Method not found: ${method}`);
});

rl.on('close', () => process.exit(0));
