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
    const baseOrder = base.map((item) => item.id);
    const localOrder = local.map((item) => item.id);
    const orderChanged = JSON.stringify(baseOrder) !== JSON.stringify(localOrder);

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
      /^https:\/\/.+\.supabase\.co$/.test(String(config.supabaseUrl || '')) &&
      String(config.supabaseAnonKey || '').length > 40
    );
  }

  class IterationPlanCollaboration {
    constructor(config, callbacks = {}) {
      this.config = { planId: 'main', ...config };
      this.callbacks = callbacks;
      this.client = null;
      this.channel = null;
      this.session = null;
      this.current = null;
      this.pendingItems = null;
      this.queuedRemote = null;
      this.saving = false;
      this.started = false;
      this.initialItems = [];
      this.presenceId = global.crypto?.randomUUID?.() || `viewer-${Date.now()}-${Math.random()}`;
      this.onlineHandler = () => this.flush();
      this.offlineHandler = () => this.status('offline', '当前离线，修改将在联网后同步');
    }

    get configured() {
      return isConfigured(this.config);
    }

    get canEdit() {
      return !this.configured || Boolean(this.session?.user);
    }

    get user() {
      return this.session?.user || null;
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

    async start(initialItems) {
      if (this.started) return;
      this.started = true;
      this.initialItems = compactItems(initialItems);

      if (!this.configured) {
        this.status('local', '仅保存在当前浏览器');
        this.authChanged();
        return;
      }
      if (!global.supabase?.createClient) {
        this.status('error', '实时同步组件加载失败');
        this.authChanged();
        return;
      }

      this.status('connecting', '正在连接共享数据');
      this.client = global.supabase.createClient(this.config.supabaseUrl, this.config.supabaseAnonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true
        }
      });

      const { data: authData, error: authError } = await this.client.auth.getSession();
      if (authError) console.warn('无法读取协作登录状态。', authError);
      this.session = authData?.session || null;
      this.authChanged();

      this.client.auth.onAuthStateChange((_event, session) => {
        this.session = session;
        this.authChanged();
        if (this.channel) this.trackPresence();
        if (session?.user && this.pendingItems) this.flush();
        this.updateIdleStatus();
      });

      await this.loadRemote();
      this.subscribe();
      global.addEventListener?.('online', this.onlineHandler);
      global.addEventListener?.('offline', this.offlineHandler);
    }

    async loadRemote() {
      const { data, error } = await this.client
        .from('iteration_plans')
        .select('id,items,revision,updated_at,updated_by')
        .eq('id', this.config.planId)
        .maybeSingle();

      if (error) {
        this.status('error', '共享数据读取失败');
        console.warn('无法读取共享规划。', error);
        return;
      }

      if (data) {
        this.current = data;
        const remoteItems = Array.isArray(data.items) && data.items.length ? data.items : this.initialItems;
        this.callbacks.onRemoteChange?.(compactItems(remoteItems), { initial: true, revision: data.revision });
      }
      this.updateIdleStatus();
    }

    subscribe() {
      this.channel = this.client
        .channel(`iteration-plan-${this.config.planId}`, {
          config: { presence: { key: this.presenceId } }
        })
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'iteration_plans', filter: `id=eq.${this.config.planId}` },
          (payload) => this.receiveRemote(payload.new)
        )
        .on('presence', { event: 'sync' }, () => {
          const state = this.channel.presenceState();
          const count = Object.values(state).reduce((total, entries) => total + entries.length, 0);
          this.callbacks.onPresenceChange?.(count);
        })
        .subscribe((state) => {
          if (state === 'SUBSCRIBED') {
            this.trackPresence();
            this.updateIdleStatus();
          } else if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT') {
            this.status('offline', '实时连接中断，等待重连');
          }
        });
    }

    async trackPresence() {
      if (!this.channel) return;
      await this.channel.track({
        viewerId: this.presenceId,
        userId: this.user?.id || null,
        joinedAt: new Date().toISOString()
      });
    }

    receiveRemote(row) {
      if (!row || Number(row.revision) <= Number(this.current?.revision || 0)) return;
      if (this.saving || this.pendingItems) {
        this.queuedRemote = row;
        return;
      }
      this.current = row;
      this.callbacks.onRemoteChange?.(compactItems(row.items), { initial: false, revision: row.revision });
      this.updateIdleStatus();
    }

    updateIdleStatus() {
      if (!this.configured) {
        this.status('local', '仅保存在当前浏览器');
      } else if (!global.navigator?.onLine) {
        this.status('offline', '当前离线，修改将在联网后同步');
      } else if (!this.user) {
        this.status('readonly', '共享数据已同步 · 登录后可编辑');
      } else {
        this.status('synced', '共享数据已同步');
      }
    }

    async signIn(email) {
      if (!this.configured) throw new Error('实时同步尚未配置');
      const redirectTo = `${global.location.origin}${global.location.pathname}`;
      const { error } = await this.client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: redirectTo, shouldCreateUser: true }
      });
      if (error) throw error;
    }

    async signOut() {
      if (!this.client) return;
      const { error } = await this.client.auth.signOut();
      if (error) throw error;
    }

    save(items) {
      const next = compactItems(items);
      if (!this.configured) {
        this.status('local', '仅保存在当前浏览器');
        return Promise.resolve({ localOnly: true });
      }
      if (!this.user) {
        const error = new Error('请先登录再编辑共享规划');
        error.code = 'AUTH_REQUIRED';
        return Promise.reject(error);
      }
      this.pendingItems = next;
      return this.flush();
    }

    async flush() {
      if (this.saving || !this.pendingItems || !this.user || !global.navigator?.onLine) return;
      this.saving = true;
      this.status('saving', '正在保存到云端');
      let unsavedItems = null;

      try {
        while (this.pendingItems) {
          const localItems = this.pendingItems;
          unsavedItems = localItems;
          this.pendingItems = null;
          const saved = await this.saveWithRetry(localItems);
          if (!saved) throw new Error('共享规划存在连续冲突，请稍后重试');
          this.current = saved;
          unsavedItems = null;
          if (!sameItems(saved.items, localItems)) {
            this.callbacks.onRemoteChange?.(compactItems(saved.items), { initial: false, merged: true, revision: saved.revision });
          }
        }
        if (this.queuedRemote && Number(this.queuedRemote.revision) > Number(this.current?.revision || 0)) {
          this.current = this.queuedRemote;
          this.callbacks.onRemoteChange?.(compactItems(this.queuedRemote.items), {
            initial: false,
            revision: this.queuedRemote.revision
          });
        }
        this.queuedRemote = null;
        this.updateIdleStatus();
      } catch (error) {
        if (unsavedItems && !this.pendingItems) this.pendingItems = unsavedItems;
        console.warn('共享规划保存失败。', error);
        this.status(global.navigator?.onLine ? 'error' : 'offline', global.navigator?.onLine ? '云端保存失败，本地副本已保留' : '当前离线，修改将在联网后同步');
      } finally {
        this.saving = false;
      }
    }

    async saveWithRetry(localItems) {
      let base = this.current || { items: this.initialItems, revision: 0 };
      let nextItems = localItems;

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const { data, error } = await this.client.rpc('save_iteration_plan', {
          p_plan_id: this.config.planId,
          p_items: nextItems,
          p_expected_revision: Number(base.revision || 0)
        });
        if (error) throw error;
        const saved = Array.isArray(data) ? data[0] : data;
        if (saved) return saved;

        const { data: latest, error: readError } = await this.client
          .from('iteration_plans')
          .select('id,items,revision,updated_at,updated_by')
          .eq('id', this.config.planId)
          .single();
        if (readError) throw readError;
        nextItems = mergeConcurrentItems(base.items, nextItems, latest.items);
        base = latest;
      }
      return null;
    }
  }

  global.IterationPlanCollaboration = IterationPlanCollaboration;
  global.mergeConcurrentIterationItems = mergeConcurrentItems;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { IterationPlanCollaboration, compactItems, mergeConcurrentItems, isConfigured };
  }
})(typeof window !== 'undefined' ? window : globalThis);
