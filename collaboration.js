(function (global) {
  'use strict';

  const CLOUDBASE_SDK_URL = 'https://cdn.jsdelivr.net/npm/@cloudbase/js-sdk@3.7.1/+esm';

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
      /^[a-z0-9-]+$/i.test(String(config.env || '')) &&
      /^[a-z][a-z0-9_-]*$/i.test(String(config.collection || '')) &&
      /^[a-z0-9_-]+$/i.test(String(config.docId || ''))
    );
  }

  function parsePayload(payload) {
    const items = Array.isArray(payload?.items)
      ? payload.items
      : Array.isArray(payload?.iterationThemes)
        ? payload.iterationThemes
        : null;
    if (!items) throw new Error('共享规划数据缺少 items 数组');
    return compactItems(items);
  }

  class IterationPlanCollaboration {
    constructor(config, callbacks = {}) {
      this.config = { pollIntervalMs: 10000, ...config };
      this.callbacks = callbacks;
      this.app = null;
      this.db = null;
      this.watcher = null;
      this.current = null;
      this.initialItems = [];
      this.pendingItems = null;
      this.queuedRemote = null;
      this.saving = false;
      this.started = false;
      this.pollTimer = null;
      this.onlineHandler = () => this.flush();
      this.offlineHandler = () => this.status('offline', '当前离线，修改将在联网后同步');
    }

    get configured() {
      return isConfigured(this.config);
    }

    get canEdit() {
      return this.configured && Boolean(this.db);
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

    document() {
      return this.db.collection(this.config.collection).doc(this.config.docId);
    }

    async start(initialItems) {
      if (this.started) return;
      this.started = true;
      this.initialItems = compactItems(initialItems);

      if (!this.configured) {
        this.status('error', 'CloudBase 共享数据尚未配置');
        this.authChanged();
        return;
      }

      this.status('connecting', '正在连接共享数据');
      try {
        const module = await import(CLOUDBASE_SDK_URL);
        const cloudbase = module.default || module;
        this.app = cloudbase.init({ env: this.config.env });
        const auth = this.app.auth();
        let signInResult;
        if (typeof auth.anonymousAuthProvider === 'function') {
          signInResult = await auth.anonymousAuthProvider().signIn();
        } else {
          signInResult = await auth.signInAnonymously();
        }
        if (signInResult?.error) throw signInResult.error;
        const loginState = await auth.getLoginState();
        if (!loginState?.user && !loginState?.isAnonymousAuth) {
          throw new Error('CloudBase 匿名登录未启用');
        }
        this.db = this.app.database();
        this.authChanged();
        await this.loadRemote(true);
        this.subscribe();
        this.pollTimer = global.setInterval(() => this.loadRemote(false), this.config.pollIntervalMs);
        global.addEventListener?.('online', this.onlineHandler);
        global.addEventListener?.('offline', this.offlineHandler);
      } catch (error) {
        console.warn('无法连接 CloudBase 共享规划。', error);
        this.status('error', '共享数据连接失败，请检查 CloudBase 配置');
        this.authChanged();
      }
    }

    async readDocument() {
      const result = await this.document().get();
      const payload = Array.isArray(result?.data) ? result.data[0] : result?.data;
      if (!payload) {
        const error = new Error('CloudBase 中尚未创建规划数据');
        error.code = 'NOT_FOUND';
        throw error;
      }
      return { items: parsePayload(payload), updatedAt: payload.updatedAt || null };
    }

    async loadRemote(initial) {
      if (!this.db || !global.navigator?.onLine) return;
      try {
        const remote = await this.readDocument();
        if (!this.current || !sameItems(this.current.items, remote.items)) {
          if (this.saving || this.pendingItems) {
            this.queuedRemote = remote;
          } else {
            this.current = remote;
            this.callbacks.onRemoteChange?.(remote.items, { initial, updatedAt: remote.updatedAt });
          }
        }
        this.updateIdleStatus();
      } catch (error) {
        if (error.code === 'NOT_FOUND') {
          try {
            const seeded = await this.writeDocument(this.initialItems);
            this.current = { items: seeded.items, updatedAt: seeded.updatedAt };
            this.callbacks.onRemoteChange?.(seeded.items, { initial: true, updatedAt: seeded.updatedAt });
            this.updateIdleStatus();
            return;
          } catch (seedError) {
            console.warn('无法初始化 CloudBase 共享规划。', seedError);
          }
        }
        console.warn('无法读取 CloudBase 共享规划。', error);
        this.status('error', '共享数据读取失败，正在重试');
      }
    }

    subscribe() {
      if (!this.db || typeof this.document().watch !== 'function') return;
      this.watcher = this.document().watch({
        onChange: (snapshot) => {
          const payload = Array.isArray(snapshot?.docs) ? snapshot.docs[0] : snapshot?.docChanges?.[0]?.doc;
          if (!payload) return;
          const remote = { items: parsePayload(payload), updatedAt: payload.updatedAt || null };
          if (this.saving || this.pendingItems) this.queuedRemote = remote;
          else if (!this.current || !sameItems(this.current.items, remote.items)) {
            this.current = remote;
            this.callbacks.onRemoteChange?.(remote.items, { initial: false, updatedAt: remote.updatedAt });
          }
          this.updateIdleStatus();
        },
        onError: (error) => {
          console.warn('CloudBase 实时监听中断。', error);
          this.status('offline', '实时连接中断，正在自动重连');
        }
      });
    }

    updateIdleStatus() {
      if (!global.navigator?.onLine) this.status('offline', '当前离线，修改将在联网后同步');
      else if (this.db) this.status('synced', '共享数据已同步 · 所有人可直接编辑');
    }

    save(items) {
      if (!this.canEdit) {
        const error = new Error('共享数据尚未连接');
        error.code = 'CONNECTION_REQUIRED';
        return Promise.reject(error);
      }
      this.pendingItems = compactItems(items);
      return this.flush();
    }

    async writeDocument(items) {
      const payload = {
        items: compactItems(items),
        updatedAt: new Date().toISOString(),
        updatedBy: 'anonymous-editor'
      };
      await this.document().set(payload);
      return payload;
    }

    async flush() {
      if (this.saving || !this.pendingItems || !this.db || !global.navigator?.onLine) return;
      this.saving = true;
      this.status('saving', '正在保存共享规划');
      let unsavedItems = null;

      try {
        while (this.pendingItems) {
          const localItems = this.pendingItems;
          unsavedItems = localItems;
          this.pendingItems = null;
          let latest;
          try {
            latest = await this.readDocument();
          } catch (error) {
            latest = { items: this.current?.items || this.initialItems };
          }
          const savedItems = mergeConcurrentItems(this.current?.items || this.initialItems, localItems, latest.items);
          const saved = await this.writeDocument(savedItems);
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
        console.warn('CloudBase 共享规划保存失败。', error);
        this.status(global.navigator?.onLine ? 'error' : 'offline', global.navigator?.onLine ? '保存失败，本地副本已保留' : '当前离线，修改将在联网后同步');
      } finally {
        this.saving = false;
      }
    }
  }

  global.IterationPlanCollaboration = IterationPlanCollaboration;
  global.mergeConcurrentIterationItems = mergeConcurrentItems;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IterationPlanCollaboration, compactItems, mergeConcurrentItems, parsePayload, isConfigured };
  }
})(typeof window !== 'undefined' ? window : globalThis);
