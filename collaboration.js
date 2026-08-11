(function (global) {
  'use strict';

  function compactItems(items) {
    return (Array.isArray(items) ? items : []).map((item) => {
      const compact = { id: item.id, start: item.start, end: item.end };
      if (typeof item.updatedBy === 'string' && item.updatedBy.trim()) compact.updatedBy = item.updatedBy.trim().slice(0, 32);
      if (typeof item.updatedAt === 'string' && !Number.isNaN(Date.parse(item.updatedAt))) compact.updatedAt = item.updatedAt;
      return compact;
    });
  }

  function sameItems(left, right) {
    return JSON.stringify(compactItems(left)) === JSON.stringify(compactItems(right));
  }

  function isOlderRevision(candidate, current) {
    const candidateTime = Date.parse(candidate || '');
    const currentTime = Date.parse(current || '');
    return !Number.isNaN(candidateTime) && !Number.isNaN(currentTime) && candidateTime < currentTime;
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

  class IterationPlanCollaboration {
    constructor(config, callbacks = {}) {
      this.config = { branch: 'main', pollIntervalMs: 10000, ...config };
      this.callbacks = callbacks;
      this.current = null;
      this.initialItems = [];
      this.pendingItems = null;
      this.pendingChange = null;
      this.queuedRemote = null;
      this.conflict = null;
      this.saving = false;
      this.started = false;
      this.gatewayReady = false;
      this.pollTimer = null;
      this.retryTimer = null;
      this.retryAttempt = 0;
      this.onlineHandler = () => {
        this.clearRetry();
        this.flush();
      };
      this.offlineHandler = () => this.status('offline', '当前离线，修改将在联网后同步');
    }

    get configured() {
      return isConfigured(this.config);
    }

    get canEdit() {
      return this.configured && this.gatewayReady;
    }

    get user() {
      return null;
    }

    status(state, message) {
      this.callbacks.onStatus?.({ state, message });
    }

    authChanged() {
      this.callbacks.onAuthChange?.({ configured: this.configured, canEdit: this.canEdit, user: null });
    }

    rawUrl() {
      return `https://raw.githubusercontent.com/${this.config.owner}/${this.config.repo}/${this.config.branch}/${this.config.path}`;
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
      await this.loadRemote(true);
      await this.checkGateway();
      this.authChanged();
      this.updateIdleStatus();
      this.pollTimer = global.setInterval(() => this.loadRemote(false), this.config.pollIntervalMs);
      global.addEventListener?.('online', this.onlineHandler);
      global.addEventListener?.('offline', this.offlineHandler);
    }

    async fetchRaw() {
      const response = await global.fetch(`${this.rawUrl()}?t=${Date.now()}`, { cache: 'no-store' });
      if (!response.ok) throw new Error(`共享规划读取失败 (${response.status})`);
      return response.json();
    }

    async checkGateway() {
      if (!/^https:\/\//.test(String(this.config.gatewayUrl || ''))) return;
      try {
        const response = await global.fetch(`${this.config.gatewayUrl}?health=1`, { cache: 'no-store' });
        this.gatewayReady = response.ok;
      } catch (error) {
        this.gatewayReady = false;
      }
    }

    async loadRemote(initial) {
      if (!this.configured || !global.navigator?.onLine) return;
      try {
        const payload = await this.fetchRaw();
        const items = parsePayload(payload);
        if (!this.current || !sameItems(this.current.items, items)) {
          const remote = { items, updatedAt: payload.updatedAt || null };
          // GitHub's public raw endpoint can briefly lag behind a successful gateway write.
          // Never let an older revision overwrite the response we just received from the gateway.
          if (this.current && isOlderRevision(remote.updatedAt, this.current.updatedAt)) return;
          if (this.saving || this.pendingItems) this.queuedRemote = remote;
          else {
            this.current = remote;
            this.callbacks.onRemoteChange?.(items, { initial, updatedAt: remote.updatedAt });
          }
        }
        if (!this.saving && !this.pendingItems && !this.retryTimer) this.updateIdleStatus();
      } catch (error) {
        console.warn('无法读取 GitHub 共享规划。', error);
        this.status('error', '共享数据读取失败，正在重试');
      }
    }

    updateIdleStatus() {
      if (!global.navigator?.onLine) this.status('offline', '当前离线，修改将在联网后同步');
      else if (!this.canEdit) this.status('readonly', '共享数据已同步 · 开放编辑网关尚未部署');
      else this.status('synced', '共享数据已同步 · 所有人可直接编辑');
    }

    clearRetry() {
      if (this.retryTimer) global.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }

    scheduleRetry() {
      if (this.retryTimer || !this.pendingItems || !this.canEdit || !global.navigator?.onLine) return;
      this.retryAttempt += 1;
      const delay = Math.min(30000, 1000 * (2 ** Math.min(this.retryAttempt - 1, 5)));
      this.status('saving', `保存遇到问题，${Math.round(delay / 1000)} 秒后自动重试`);
      this.retryTimer = global.setTimeout(() => {
        this.retryTimer = null;
        this.flush();
      }, delay);
    }

    save(items, change = {}) {
      if (!this.canEdit) {
        const error = new Error('开放编辑网关尚未部署');
        error.code = 'GATEWAY_REQUIRED';
        return Promise.reject(error);
      }
      this.pendingItems = compactItems(items);
      this.pendingChange = {
        actor: typeof change.actor === 'string' ? change.actor.trim().slice(0, 32) : '',
        changedIds: Array.isArray(change.changedIds) ? change.changedIds.filter((id) => typeof id === 'string') : []
      };
      this.conflict = null;
      this.clearRetry();
      this.retryAttempt = 0;
      return this.flush();
    }

    async saveWithGateway(baseItems, items, change) {
      const response = await global.fetch(this.config.gatewayUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseItems: compactItems(baseItems),
          items: compactItems(items),
          actor: change?.actor || '',
          changedIds: change?.changedIds || []
        })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const error = new Error(payload.message || `共享规划保存失败 (${response.status})`);
        error.code = payload.code;
        if (Array.isArray(payload.items)) error.remote = { items: parsePayload(payload), updatedAt: payload.updatedAt || null };
        error.conflicts = Array.isArray(payload.conflicts) ? payload.conflicts : [];
        throw error;
      }
      return { items: parsePayload(payload), updatedAt: payload.updatedAt || null };
    }

    resolveConflict(keepLocal) {
      if (!this.conflict) return;
      const { remote } = this.conflict;
      this.conflict = null;
      this.current = remote;
      if (keepLocal) {
        this.status('saving', '正在按你的选择保存修改');
        global.setTimeout(() => this.flush(), 0);
        return;
      }
      this.pendingItems = null;
      this.queuedRemote = null;
      this.callbacks.onRemoteChange?.(remote.items, { initial: false, updatedAt: remote.updatedAt });
      this.updateIdleStatus();
    }

    async flush() {
      if (this.saving || this.retryTimer || !this.pendingItems || !this.canEdit || !global.navigator?.onLine) return;
      this.saving = true;
      this.status('saving', '正在保存共享规划');
      let unsavedItems = null;
      let unsavedChange = null;

      try {
        while (this.pendingItems) {
          const localItems = this.pendingItems;
          const localChange = this.pendingChange;
          unsavedItems = localItems;
          unsavedChange = localChange;
          this.pendingItems = null;
          this.pendingChange = null;
          const saved = await this.saveWithGateway(this.current?.items || this.initialItems, localItems, localChange);
          this.current = saved;
          unsavedItems = null;
          unsavedChange = null;
          if (this.pendingItems) this.pendingItems = mergeConcurrentItems(localItems, this.pendingItems, saved.items);
          if (!sameItems(saved.items, localItems) && !this.pendingItems) {
            this.callbacks.onRemoteChange?.(saved.items, { initial: false, merged: true, updatedAt: saved.updatedAt });
          }
        }
        if (this.queuedRemote && Date.parse(this.queuedRemote.updatedAt || '') > Date.parse(this.current.updatedAt || '')) {
          this.current = this.queuedRemote;
          this.callbacks.onRemoteChange?.(this.queuedRemote.items, { initial: false, updatedAt: this.queuedRemote.updatedAt });
        }
        this.queuedRemote = null;
        this.retryAttempt = 0;
        this.updateIdleStatus();
      } catch (error) {
        if (unsavedItems && !this.pendingItems) {
          this.pendingItems = unsavedItems;
          this.pendingChange = unsavedChange;
        }
        console.warn('GitHub 共享规划保存失败。', error);
        if (error.code === 'CONFLICT' && error.remote) {
          this.current = error.remote;
          this.conflict = { remote: error.remote, conflicts: error.conflicts };
          this.status('conflict', '检测到同一内容的并发修改，等待你的选择');
          this.callbacks.onConflict?.({ conflicts: error.conflicts, localItems: this.pendingItems, remoteItems: error.remote.items });
        } else if (global.navigator?.onLine && this.canEdit) this.scheduleRetry();
        else this.status('offline', '当前离线，修改将在联网后同步');
      } finally {
        this.saving = false;
      }
    }
  }

  global.IterationPlanCollaboration = IterationPlanCollaboration;
  global.mergeConcurrentIterationItems = mergeConcurrentItems;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IterationPlanCollaboration, compactItems, findConcurrentConflicts, isOlderRevision, mergeConcurrentItems, parsePayload, isConfigured };
  }
})(typeof window !== 'undefined' ? window : globalThis);
