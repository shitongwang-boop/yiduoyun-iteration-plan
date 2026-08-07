(function (global) {
  'use strict';

  function compactItems(items) {
    return (Array.isArray(items) ? items : []).map(({ id, start, end }) => ({ id, start, end }));
  }

  function sameItems(left, right) {
    return JSON.stringify(compactItems(left)) === JSON.stringify(compactItems(right));
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

  function isConfigured(config) {
    return Boolean(
      config &&
      /^[A-Za-z0-9-]+$/.test(String(config.owner || '')) &&
      /^[A-Za-z0-9._-]+$/.test(String(config.repo || '')) &&
      /^[A-Za-z0-9._/-]+\.json$/.test(String(config.path || ''))
    );
  }

  function parsePayload(payload) {
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.iterationThemes)
        ? payload.iterationThemes
        : null;
    if (!items) throw new Error('共享规划文件缺少 items 数组');
    return compactItems(items);
  }

  function encodeBase64(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    return global.btoa(binary);
  }

  function decodeBase64(value) {
    const binary = global.atob(String(value || '').replace(/\n/g, ''));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  class IterationPlanCollaboration {
    constructor(config, callbacks = {}) {
      this.config = { branch: 'main', pollIntervalMs: 15000, ...config };
      this.callbacks = callbacks;
      this.current = null;
      this.initialItems = [];
      this.pendingItems = null;
      this.queuedRemote = null;
      this.saving = false;
      this.started = false;
      this.pollTimer = null;
      this.githubUser = null;
      this.tokenStorageKey = `yiduoyun-github-token:${this.config.owner}/${this.config.repo}`;
      this.token = global.sessionStorage?.getItem(this.tokenStorageKey) || '';
      this.onlineHandler = () => this.flush();
      this.offlineHandler = () => this.status('offline', '当前离线，修改将在联网后同步');
    }

    get configured() {
      return isConfigured(this.config);
    }

    get canEdit() {
      return this.configured && Boolean(this.token);
    }

    get user() {
      return this.githubUser ? { login: this.githubUser.login } : this.token ? { login: 'GitHub 已授权' } : null;
    }

    status(state, message) {
      this.callbacks.onStatus?.({ state, message });
    }

    authChanged() {
      this.callbacks.onAuthChange?.({
        configured: this.configured,
        canEdit: this.canEdit,
        user: this.user
      });
    }

    rawUrl() {
      return `https://raw.githubusercontent.com/${this.config.owner}/${this.config.repo}/${this.config.branch}/${this.config.path}`;
    }

    apiUrl() {
      return `https://api.github.com/repos/${this.config.owner}/${this.config.repo}/contents/${this.config.path}`;
    }

    headers(withToken = false) {
      const headers = { Accept: 'application/vnd.github+json' };
      if (withToken && this.token) headers.Authorization = `Bearer ${this.token}`;
      return headers;
    }

    async start(initialItems) {
      if (this.started) return;
      this.started = true;
      this.initialItems = compactItems(initialItems);

      if (!this.configured) {
        this.status('error', 'GitHub 共享数据尚未配置');
        this.authChanged();
        return;
      }

      this.authChanged();
      if (this.token) {
        try {
          await this.loadGitHubUser();
        } catch (error) {
          console.warn('GitHub 编辑授权已失效。', error);
          this.signOut();
          this.status('readonly', 'GitHub 授权已失效，请重新授权');
        }
      }
      await this.loadRemote(true);
      this.pollTimer = global.setInterval(() => this.loadRemote(false), this.config.pollIntervalMs);
      global.addEventListener?.('online', this.onlineHandler);
      global.addEventListener?.('offline', this.offlineHandler);
    }

    async fetchRaw() {
      const response = await global.fetch(`${this.rawUrl()}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`共享规划读取失败 (${response.status})`);
      return response.json();
    }

    async loadRemote(initial) {
      if (!this.configured || !global.navigator?.onLine) return;
      try {
        const payload = await this.fetchRaw();
        const items = parsePayload(payload);
        if (!this.current || !sameItems(this.current.items, items)) {
          const remote = { items, updatedAt: payload.updatedAt || null };
          if (this.saving || this.pendingItems) {
            this.queuedRemote = remote;
          } else {
            this.current = remote;
            this.callbacks.onRemoteChange?.(items, { initial, updatedAt: payload.updatedAt || null });
          }
        }
        this.updateIdleStatus();
      } catch (error) {
        console.warn('无法读取 GitHub 共享规划。', error);
        this.status('error', '共享数据读取失败，正在重试');
      }
    }

    updateIdleStatus() {
      if (!global.navigator?.onLine) {
        this.status('offline', '当前离线，修改将在联网后同步');
      } else if (!this.token) {
        this.status('readonly', '共享数据已同步 · GitHub 授权后可编辑');
      } else {
        this.status('synced', '共享数据已同步');
      }
    }

    async loadGitHubUser() {
      const response = await global.fetch('https://api.github.com/user', { headers: this.headers(true) });
      if (!response.ok) throw new Error('GitHub 令牌无效或已过期');
      this.githubUser = await response.json();
      this.authChanged();
    }

    async signIn(token) {
      if (!this.configured) throw new Error('GitHub 共享数据尚未配置');
      if (!token) throw new Error('请输入 GitHub 细粒度令牌');
      const previousToken = this.token;
      this.token = token;
      try {
        await this.loadGitHubUser();
        await this.getRepositoryContent();
        global.sessionStorage?.setItem(this.tokenStorageKey, token);
        this.authChanged();
        this.updateIdleStatus();
      } catch (error) {
        this.token = previousToken;
        throw error;
      }
    }

    signOut() {
      global.sessionStorage?.removeItem(this.tokenStorageKey);
      this.token = '';
      this.githubUser = null;
      this.authChanged();
      this.updateIdleStatus();
    }

    save(items) {
      if (!this.canEdit) {
        const error = new Error('请先完成 GitHub 编辑授权');
        error.code = 'AUTH_REQUIRED';
        return Promise.reject(error);
      }
      this.pendingItems = compactItems(items);
      return this.flush();
    }

    async getRepositoryContent() {
      const response = await global.fetch(`${this.apiUrl()}?ref=${encodeURIComponent(this.config.branch)}`, {
        headers: this.headers(true)
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('GitHub 令牌没有该仓库的 Contents 读写权限');
        throw new Error(`无法读取 GitHub 文件 (${response.status})`);
      }
      const content = await response.json();
      return { sha: content.sha, payload: JSON.parse(decodeBase64(content.content)) };
    }

    async putRepositoryContent(items, sha) {
      const payload = {
        schemaVersion: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: this.githubUser?.login || 'github-editor',
        items: compactItems(items)
      };
      const response = await global.fetch(this.apiUrl(), {
        method: 'PUT',
        headers: { ...this.headers(true), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `Update iteration plan (${payload.updatedAt})`,
          content: encodeBase64(`${JSON.stringify(payload, null, 2)}\n`),
          branch: this.config.branch,
          sha
        })
      });
      if (response.status === 409) return null;
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('GitHub 令牌没有该仓库的 Contents 写入权限');
        throw new Error(`GitHub 保存失败 (${response.status})`);
      }
      return payload;
    }

    async flush() {
      if (this.saving || !this.pendingItems || !this.canEdit || !global.navigator?.onLine) return;
      this.saving = true;
      this.status('saving', '正在提交共享规划');
      let unsavedItems = null;

      try {
        while (this.pendingItems) {
          const localItems = this.pendingItems;
          unsavedItems = localItems;
          this.pendingItems = null;
          const saved = await this.saveWithRetry(localItems);
          if (!saved) throw new Error('多人同时修改过于频繁，请稍后重试');
          this.current = { items: saved.items, updatedAt: saved.updatedAt };
          unsavedItems = null;
          if (!sameItems(saved.items, localItems)) {
            this.callbacks.onRemoteChange?.(saved.items, { initial: false, merged: true, updatedAt: saved.updatedAt });
          }
        }
        if (this.queuedRemote && Date.parse(this.queuedRemote.updatedAt || '') > Date.parse(this.current.updatedAt || '')) {
          this.current = this.queuedRemote;
          this.callbacks.onRemoteChange?.(this.queuedRemote.items, { initial: false, updatedAt: this.queuedRemote.updatedAt });
        }
        this.queuedRemote = null;
        this.updateIdleStatus();
      } catch (error) {
        if (unsavedItems && !this.pendingItems) this.pendingItems = unsavedItems;
        console.warn('GitHub 共享规划保存失败。', error);
        this.status(global.navigator?.onLine ? 'error' : 'offline', global.navigator?.onLine ? '提交失败，本地副本已保留' : '当前离线，修改将在联网后同步');
      } finally {
        this.saving = false;
      }
    }

    async saveWithRetry(localItems) {
      const baseItems = compactItems(this.current?.items || this.initialItems);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const latest = await this.getRepositoryContent();
        const nextItems = mergeConcurrentItems(baseItems, localItems, parsePayload(latest.payload));
        const saved = await this.putRepositoryContent(nextItems, latest.sha);
        if (saved) return saved;
      }
      return null;
    }
  }

  global.IterationPlanCollaboration = IterationPlanCollaboration;
  global.mergeConcurrentIterationItems = mergeConcurrentItems;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IterationPlanCollaboration, compactItems, mergeConcurrentItems, parsePayload, isConfigured };
  }
})(typeof window !== 'undefined' ? window : globalThis);
