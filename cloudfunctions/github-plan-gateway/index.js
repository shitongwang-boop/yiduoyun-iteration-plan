'use strict';

const DEFAULTS = {
  owner: 'shitongwang-boop',
  repo: 'yiduoyun-iteration-plan',
  branch: 'main',
  path: 'data/iteration-plan.json'
};

function compactItems(items) {
  return (Array.isArray(items) ? items : []).map(({ id, start, end }) => ({ id, start, end }));
}

function mergeConcurrentItems(baseItems, localItems, remoteItems) {
  const base = compactItems(baseItems);
  const local = compactItems(localItems);
  const remote = compactItems(remoteItems);
  const baseById = Object.fromEntries(base.map((item) => [item.id, item]));
  const remoteById = Object.fromEntries(remote.map((item) => [item.id, { ...item }]));
  const localOrder = local.map((item) => item.id);
  const orderChanged = JSON.stringify(base.map((item) => item.id)) !== JSON.stringify(localOrder);

  local.forEach((item) => {
    const previous = baseById[item.id];
    const latest = remoteById[item.id];
    if (!previous || !latest) return;
    if (item.start !== previous.start) latest.start = item.start;
    if (item.end !== previous.end) latest.end = item.end;
    if (latest.start > latest.end) {
      latest.start = item.start;
      latest.end = item.end;
    }
  });

  const remoteOrder = remote.map((item) => item.id);
  const desiredOrder = orderChanged ? localOrder : remoteOrder;
  const merged = desiredOrder.filter((id) => remoteById[id]).map((id) => remoteById[id]);
  remote.forEach((item) => {
    if (!desiredOrder.includes(item.id)) merged.push(remoteById[item.id]);
  });
  return merged;
}

function findConcurrentConflicts(baseItems, localItems, remoteItems) {
  const baseById = Object.fromEntries(compactItems(baseItems).map((item) => [item.id, item]));
  const local = compactItems(localItems);
  const remote = compactItems(remoteItems);
  const remoteById = Object.fromEntries(remote.map((item) => [item.id, item]));
  const conflicts = [];

  local.forEach((item) => {
    const previous = baseById[item.id];
    const latest = remoteById[item.id];
    if (!previous || !latest) return;
    const localStartChanged = item.start !== previous.start;
    const localEndChanged = item.end !== previous.end;
    const remoteStartChanged = latest.start !== previous.start;
    const remoteEndChanged = latest.end !== previous.end;

    ['start', 'end'].forEach((field) => {
      if (item[field] !== previous[field] && latest[field] !== previous[field] && item[field] !== latest[field]) {
        conflicts.push({ id: item.id, field, local: item[field], remote: latest[field] });
      }
    });

    if ((localStartChanged && remoteEndChanged) || (localEndChanged && remoteStartChanged)) {
      const start = localStartChanged ? item.start : latest.start;
      const end = localEndChanged ? item.end : latest.end;
      if (start > end) conflicts.push({ id: item.id, field: 'range', local: `${item.start}..${item.end}`, remote: `${latest.start}..${latest.end}` });
    }
  });

  const baseOrder = compactItems(baseItems).map((item) => item.id);
  const localOrder = local.map((item) => item.id);
  const remoteOrder = remote.map((item) => item.id);
  if (JSON.stringify(localOrder) !== JSON.stringify(baseOrder) && JSON.stringify(remoteOrder) !== JSON.stringify(baseOrder) && JSON.stringify(localOrder) !== JSON.stringify(remoteOrder)) {
    conflicts.push({ field: 'order' });
  }
  return conflicts;
}

function settings() {
  return {
    owner: process.env.GITHUB_OWNER || DEFAULTS.owner,
    repo: process.env.GITHUB_REPO || DEFAULTS.repo,
    branch: process.env.GITHUB_BRANCH || DEFAULTS.branch,
    path: process.env.GITHUB_PATH || DEFAULTS.path,
    token: process.env.GITHUB_TOKEN
  };
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': process.env.ALLOWED_ORIGIN || 'https://shitongwang-boop.github.io',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function getMethod(event) {
  return String(event.httpMethod || event.requestContext?.httpMethod || 'GET').toUpperCase();
}

function getBody(event) {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

function contentsUrl(config) {
  return `https://api.github.com/repos/${config.owner}/${config.repo}/contents/${config.path}`;
}

function headers(config) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${config.token}`,
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

function validateItems(items, remoteItems) {
  const normalized = compactItems(items);
  const remoteIds = new Set(compactItems(remoteItems).map((item) => item.id));
  if (normalized.length !== remoteIds.size || new Set(normalized.map((item) => item.id)).size !== normalized.length) {
    throw new Error('规划主题不完整或存在重复');
  }
  normalized.forEach((item) => {
    if (!remoteIds.has(item.id) || !/^\d{4}-\d{2}-\d{2}$/.test(item.start) || !/^\d{4}-\d{2}-\d{2}$/.test(item.end) || item.start > item.end) {
      throw new Error('规划数据格式无效');
    }
  });
  return normalized;
}

async function readLatest(config) {
  const result = await fetch(`${contentsUrl(config)}?ref=${encodeURIComponent(config.branch)}`, { headers: headers(config) });
  if (!result.ok) throw new Error(`GitHub 读取失败 (${result.status})`);
  const content = await result.json();
  const payload = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8'));
  if (!Array.isArray(payload.items)) throw new Error('GitHub 规划文件格式无效');
  return { sha: content.sha, payload };
}

async function writeLatest(config, items, sha) {
  const payload = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    updatedBy: 'public-gateway',
    items: compactItems(items)
  };
  const result = await fetch(contentsUrl(config), {
    method: 'PUT',
    headers: { ...headers(config), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: `Update iteration plan (${payload.updatedAt})`,
      content: Buffer.from(`${JSON.stringify(payload, null, 2)}\n`).toString('base64'),
      branch: config.branch,
      sha
    })
  });
  if (result.status === 409) return null;
  if (!result.ok) throw new Error(`GitHub 保存失败 (${result.status})`);
  return payload;
}

async function handleRequest(event) {
  const method = getMethod(event);
  if (method === 'OPTIONS') return response(204, {});
  if (method === 'GET') return response(200, { ok: true });
  if (method !== 'POST') return response(405, { message: 'Method not allowed' });

  const config = settings();
  if (!config.token) return response(500, { message: '网关尚未配置 GitHub 写入令牌' });

  try {
    const request = getBody(event);
    if (!Array.isArray(request.items) || !Array.isArray(request.baseItems)) {
      return response(400, { message: '请求缺少规划数据' });
    }

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const latest = await readLatest(config);
      const localItems = validateItems(request.items, latest.payload.items);
      const baseItems = validateItems(request.baseItems, latest.payload.items);
      const conflicts = findConcurrentConflicts(baseItems, localItems, latest.payload.items);
      if (conflicts.length) {
        return response(409, {
          code: 'CONFLICT',
          message: '检测到同一内容已被他人更新，请选择保留自己的修改或采用最新数据',
          conflicts,
          items: latest.payload.items,
          updatedAt: latest.payload.updatedAt || null
        });
      }
      const merged = mergeConcurrentItems(baseItems, localItems, latest.payload.items);
      const saved = await writeLatest(config, merged, latest.sha);
      if (saved) return response(200, saved);
    }
    return response(409, { message: '多人同时修改过于频繁，请稍后重试' });
  } catch (error) {
    console.error('GitHub planning gateway failed.', error);
    return response(500, { message: error.message || '保存共享规划失败' });
  }
}

// CloudBase HTTP functions pass Node's request and response objects. Returning
// the same value when no response object is supplied keeps local testing simple.
exports.main = async (request, responseObject) => {
  const event = responseObject
    ? {
        httpMethod: request.method,
        headers: request.headers,
        body: request.body,
        queryStringParameters: request.query
      }
    : request;
  const result = await handleRequest(event || {});
  if (!responseObject) return result;
  responseObject.statusCode = result.statusCode;
  Object.entries(result.headers).forEach(([name, value]) => responseObject.setHeader(name, value));
  responseObject.end(result.body);
};
