// =====================================================================
// Mock 数据层 —— 不依赖真实 Supabase，模拟 Auth + Postgres + RLS + 改价历史
// 用途：本地验证公式、工序 CRUD、权限分支、页面无数据泄露
// 规则：
//   - 登录邮箱含 'admin' 为管理员，否则为 viewer
//   - viewer 只读，所有写操作返回 403
//   - price_history 仅 admin 可读，写操作由触发器模拟
// UMD 兼容浏览器 window.MockDB 与 Node require
// =====================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.MockDB = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 基准数据已移除（公开仓库不含真实工序/工时数据）
  // 生产环境数据由 Supabase 提供；本地 mock 验证请自行填入测试数据
  var BASELINE_PROCESSES = [];

  function uid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function MockDB() {
    this._user = null;        // { id, email, role }
    this._processes = BASELINE_PROCESSES.map(function (p) {
      var o = clone(p); o.id = uid(); o.created_at = new Date().toISOString(); o.updated_at = o.created_at; return o;
    });
    this._settings = { id: 1, defaultHourlyWage: 27, defaultAllowanceRate: 0.15, decimalPlaces: 4, updated_at: new Date().toISOString(), updated_by: null };
    this._history = [];
    this._listeners = { processes: [], settings: [] };
  }

  MockDB.prototype._emit = function (table, payload) {
    (this._listeners[table] || []).forEach(function (fn) {
      try { fn(payload); } catch (e) { /* ignore listener errors */ }
    });
  };

  // ---------- Auth ----------
  MockDB.prototype.signIn = function (email, password) {
    var role = (email || '').toLowerCase().indexOf('admin') >= 0 ? 'admin' : 'viewer';
    this._user = { id: uid(), email: email, role: role };
    return Promise.resolve({ data: { user: clone(this._user) }, error: null });
  };

  MockDB.prototype.signOut = function () {
    this._user = null;
    return Promise.resolve({ error: null });
  };

  MockDB.prototype.getCurrentUser = function () {
    return this._user ? clone(this._user) : null;
  };

  MockDB.prototype.getRole = function () {
    return this._user ? this._user.role : null;
  };

  MockDB.prototype._isAdmin = function () {
    return this._user && this._user.role === 'admin';
  };

  // ---------- 模拟 RLS 错误 ----------
  MockDB.prototype._denied = function () {
    return { data: null, error: { message: '权限不足：仅管理员可执行此操作', code: '42501' } };
  };

  // ---------- Processes ----------
  MockDB.prototype.listProcesses = function () {
    return Promise.resolve({ data: clone(this._processes), error: null });
  };

  MockDB.prototype.createProcess = function (p) {
    if (!this._isAdmin()) return Promise.resolve(this._denied());
    // 编号唯一检查
    var code = Number(p.code);
    if (!code || this._processes.some(function (x) { return x.code === code; })) {
      return Promise.resolve({ data: null, error: { message: '编号已存在或无效', code: '23505' } });
    }
    var now = new Date().toISOString();
    var row = {
      id: uid(),
      code: code,
      category: p.category || '',
      name: p.name || '',
      operationTime: Number(p.operationTime) || 0,
      allowanceRate: Number(p.allowanceRate) || 0,
      hourlyWage: Number(p.hourlyWage) || 0,
      netBagTime: Number(p.netBagTime) || 0,
      remarks: p.remarks || '',
      enabled: p.enabled !== false,
      created_at: now, updated_at: now
    };
    this._processes.push(row);
    this._pushHistory(row, 'create', null, '工序已创建');
    this._emit('processes', { type: 'INSERT', row: clone(row) });
    return Promise.resolve({ data: clone(row), error: null });
  };

  MockDB.prototype.updateProcess = function (id, patch) {
    if (!this._isAdmin()) return Promise.resolve(this._denied());
    var idx = this._processes.findIndex(function (x) { return x.id === id; });
    if (idx < 0) return Promise.resolve({ data: null, error: { message: '工序不存在', code: '42P01' } });
    var old = clone(this._processes[idx]);
    var row = this._processes[idx];
    var fields = ['code', 'category', 'name', 'operationTime', 'allowanceRate', 'hourlyWage', 'netBagTime', 'remarks', 'enabled'];
    fields.forEach(function (f) {
      if (patch[f] !== undefined) {
        if (f === 'code' || f === 'operationTime' || f === 'allowanceRate' || f === 'hourlyWage' || f === 'netBagTime') {
          row[f] = Number(patch[f]);
        } else {
          row[f] = patch[f];
        }
      }
    });
    row.updated_at = new Date().toISOString();
    // 写历史（触发器模拟）
    this._writeHistory(old, row);
    this._emit('processes', { type: 'UPDATE', row: clone(row) });
    return Promise.resolve({ data: clone(row), error: null });
  };

  MockDB.prototype.deleteProcess = function (id) {
    if (!this._isAdmin()) return Promise.resolve(this._denied());
    var idx = this._processes.findIndex(function (x) { return x.id === id; });
    if (idx < 0) return Promise.resolve({ data: null, error: { message: '工序不存在', code: '42P01' } });
    var old = clone(this._processes[idx]);
    this._processes.splice(idx, 1);
    this._pushHistory(old, 'delete', '工序已存在', '工序已删除');
    this._emit('processes', { type: 'DELETE', old_row: old });
    return Promise.resolve({ data: { id: id }, error: null });
  };

  MockDB.prototype._writeHistory = function (oldRow, newRow) {
    var self = this;
    var track = ['operationTime', 'allowanceRate', 'hourlyWage', 'netBagTime', 'name', 'category', 'enabled', 'remarks'];
    track.forEach(function (f) {
      if (String(oldRow[f]) !== String(newRow[f])) {
        self._pushHistory(newRow, f, String(oldRow[f]), String(newRow[f]));
      }
    });
  };

  MockDB.prototype._pushHistory = function (row, field, oldVal, newVal) {
    this._history.unshift({
      id: this._history.length + 1,
      process_id: row.id,
      process_code: row.code,
      process_name: row.name,
      field_name: field,
      old_value: oldVal,
      new_value: newVal,
      changed_by: this._user ? this._user.id : null,
      changed_by_email: this._user ? this._user.email : null,
      changed_at: new Date().toISOString()
    });
  };

  // ---------- Settings ----------
  MockDB.prototype.getSettings = function () {
    return Promise.resolve({ data: clone(this._settings), error: null });
  };

  MockDB.prototype.updateSettings = function (patch) {
    if (!this._isAdmin()) return Promise.resolve(this._denied());
    if (patch.defaultHourlyWage !== undefined) this._settings.defaultHourlyWage = Number(patch.defaultHourlyWage);
    if (patch.defaultAllowanceRate !== undefined) this._settings.defaultAllowanceRate = Number(patch.defaultAllowanceRate);
    if (patch.decimalPlaces !== undefined) this._settings.decimalPlaces = Number(patch.decimalPlaces);
    this._settings.updated_at = new Date().toISOString();
    this._settings.updated_by = this._user ? this._user.id : null;
    this._emit('settings', { type: 'UPDATE', row: clone(this._settings) });
    return Promise.resolve({ data: clone(this._settings), error: null });
  };

  // ---------- History（仅 admin 可读） ----------
  MockDB.prototype.listHistory = function (limit) {
    if (!this._isAdmin()) return Promise.resolve(this._denied());
    var rows = clone(this._history);
    if (limit) rows = rows.slice(0, limit);
    return Promise.resolve({ data: rows, error: null });
  };

  // ---------- Realtime 订阅 ----------
  MockDB.prototype.subscribe = function (table, callback) {
    if (!this._listeners[table]) this._listeners[table] = [];
    this._listeners[table].push(callback);
    var self = this;
    return function unsubscribe() {
      var arr = self._listeners[table];
      var i = arr.indexOf(callback);
      if (i >= 0) arr.splice(i, 1);
    };
  };

  // 暴露内部数据供测试断言
  MockDB.prototype._internal = function () {
    return { processes: this._processes, settings: this._settings, history: this._history };
  };

  return MockDB;
}));

