// =====================================================================
// 凯兴计件单价系统 · 共享版主逻辑
// 依赖：config.js、calc.js（window.KxCalc），mock.js 仅在 USE_MOCK=true 时加载
// Supabase 通过 CDN 加载（window.supabase）
// =====================================================================
(function () {
  'use strict';

  var CFG = window.KX_CONFIG || {};
  var Calc = window.KxCalc;

  // ---------- 数据层适配 ----------
  // MockDB 适配器（mock.js 提供）
  function MockAdapter() {
    this._db = new window.MockDB();
  }
  MockAdapter.prototype.signIn = function (e, p) { return this._db.signIn(e, p); };
  MockAdapter.prototype.signOut = function () { return this._db.signOut(); };
  MockAdapter.prototype.getCurrentUser = function () { return this._db.getCurrentUser(); };
  MockAdapter.prototype.getRole = function () { return Promise.resolve(this._db.getRole()); };
  MockAdapter.prototype.listProcesses = function () { return this._db.listProcesses(); };
  MockAdapter.prototype.createProcess = function (p) { return this._db.createProcess(p); };
  MockAdapter.prototype.updateProcess = function (id, p) { return this._db.updateProcess(id, p); };
  MockAdapter.prototype.deleteProcess = function (id) { return this._db.deleteProcess(id); };
  MockAdapter.prototype.getSettings = function () { return this._db.getSettings(); };
  MockAdapter.prototype.updateSettings = function (p) { return this._db.updateSettings(p); };
  MockAdapter.prototype.listHistory = function (n) { return this._db.listHistory(n); };
  MockAdapter.prototype.subscribe = function (t, cb) { return this._db.subscribe(t, cb); };

  // Supabase 适配器
  function SupabaseAdapter(url, key) {
    this._sb = window.supabase.createClient(url, key, {
      realtime: { params: { eventsPerSecond: 10 } }
    });
  }
  SupabaseAdapter.prototype.signIn = function (email, password) {
    return this._sb.auth.signInWithPassword({ email: email, password: password });
  };
  SupabaseAdapter.prototype.signOut = function () {
    return this._sb.auth.signOut();
  };
  SupabaseAdapter.prototype.getCurrentUser = function () {
    var s = this._sb.auth.currentUser;
    return s ? { id: s.id, email: s.email } : null;
  };
  SupabaseAdapter.prototype.getRole = function () {
    var self = this;
    var u = this.getCurrentUser();
    if (!u) return Promise.resolve(null);
    return this._sb.from('user_roles').select('role').eq('user_id', u.id).maybeSingle().then(function (res) {
      if (res.error) return 'viewer';
      return (res.data && res.data.role) || 'viewer';
    });
  };
  SupabaseAdapter.prototype.listProcesses = function () {
    return this._sb.from('processes').select('*').order('code', { ascending: true });
  };
  SupabaseAdapter.prototype.createProcess = function (p) {
    return this._sb.from('processes').insert({
      code: p.code, category: p.category, name: p.name,
      operation_time: p.operationTime, allowance_rate: p.allowanceRate,
      hourly_wage: p.hourlyWage, net_bag_time: p.netBagTime,
      remarks: p.remarks, enabled: p.enabled
    }).select().single();
  };
  SupabaseAdapter.prototype.updateProcess = function (id, patch) {
    var map = {
      code: 'code', category: 'category', name: 'name',
      operationTime: 'operation_time', allowanceRate: 'allowance_rate',
      hourlyWage: 'hourly_wage', netBagTime: 'net_bag_time',
      remarks: 'remarks', enabled: 'enabled'
    };
    var db = {};
    for (var k in patch) { if (map[k] !== undefined) db[map[k]] = patch[k]; }
    return this._sb.from('processes').update(db).eq('id', id).select().single();
  };
  SupabaseAdapter.prototype.deleteProcess = function (id) {
    return this._sb.from('processes').delete().eq('id', id);
  };
  SupabaseAdapter.prototype.getSettings = function () {
    return this._sb.from('settings').select('*').eq('id', 1).single();
  };
  SupabaseAdapter.prototype.updateSettings = function (patch) {
    var db = {};
    if (patch.defaultHourlyWage !== undefined) db.default_hourly_wage = patch.defaultHourlyWage;
    if (patch.defaultAllowanceRate !== undefined) db.default_allowance_rate = patch.defaultAllowanceRate;
    if (patch.decimalPlaces !== undefined) db.decimal_places = patch.decimalPlaces;
    return this._sb.from('settings').update(db).eq('id', 1).select().single();
  };
  SupabaseAdapter.prototype.listHistory = function (limit) {
    return this._sb.from('price_history').select('*').order('changed_at', { ascending: false }).limit(limit || 200);
  };
  SupabaseAdapter.prototype.subscribe = function (table, cb) {
    var ch = this._sb.channel('kx-' + table);
    ch.on('postgres_changes', { event: '*', schema: 'public', table: table }, function (payload) {
      cb(payload);
    }).subscribe();
    return function () { ch.unsubscribe(); };
  };

  // 字段映射（Supabase 返回 snake_case，统一转 camelCase）
  function normProcess(row) {
    return {
      id: row.id,
      code: row.code,
      category: row.category,
      name: row.name,
      operationTime: Number(row.operation_time),
      allowanceRate: Number(row.allowance_rate),
      hourlyWage: Number(row.hourly_wage),
      netBagTime: Number(row.net_bag_time),
      remarks: row.remarks || '',
      enabled: row.enabled
    };
  }
  function normSettings(row) {
    return {
      id: row.id,
      defaultHourlyWage: Number(row.default_hourly_wage),
      defaultAllowanceRate: Number(row.default_allowance_rate),
      decimalPlaces: Number(row.decimal_places)
    };
  }

  // ---------- 应用状态 ----------
  var db = null;
  var state = {
    user: null,
    role: null,            // 'admin' | 'viewer'
    processes: [],
    settings: null,
    keyword: '',
    catFilter: '',
    selectedIds: [],
    currentProcess: null,
    currentOriginal: null,
    isNew: false,
    efficiency: 1.0,
    decimalPlaces: 4,
    quantity: 1,
    batchQty: 1,
    history: [],
    tab: 'list',
    unsub: []              // realtime 取消订阅函数
  };

  // ---------- 配置解析（支持浏览器本地 localStorage 覆盖，避免密钥落盘） ----------
  var LS_KEY = 'kx_supabase_config';
  function getConfig() {
    // 优先用 localStorage 中的值，其次用 config.js 占位符
    var local = {};
    try {
      var s = localStorage.getItem(LS_KEY);
      if (s) local = JSON.parse(s) || {};
    } catch (e) {}
    return {
      SUPABASE_URL: (local.SUPABASE_URL || CFG.SUPABASE_URL || '').trim(),
      SUPABASE_ANON_KEY: (local.SUPABASE_ANON_KEY || CFG.SUPABASE_ANON_KEY || '').trim(),
      USE_MOCK: CFG.USE_MOCK
    };
  }
  function saveConfigLocally(url, key) {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ SUPABASE_URL: url.trim(), SUPABASE_ANON_KEY: key.trim() }));
      return true;
    } catch (e) { return false; }
  }

  // ---------- 初始化 ----------
  function init() {
    var cfg = getConfig();
    if (cfg.USE_MOCK) {
      db = new MockAdapter();
      bootstrap();
      return;
    }
    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      showConfigSetup();
      return;
    }
    // 用解析后的配置初始化 Supabase（不要修改全局 CFG，仅本次使用）
    db = new SupabaseAdapter(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    bootstrap();
  }

  // ---------- 浏览器本地配置表单（密钥存入 localStorage，不落盘进源码） ----------
  function showConfigSetup(msg) {
    var html =
      '<div class="login-wrap">' +
        '<div class="login-card">' +
          '<div class="login-title">Supabase 连接配置</div>' +
          '<div class="login-sub">密钥仅保存在本机浏览器（localStorage），不会写入源码或上传服务器</div>' +
          (msg ? '<div class="login-err">' + msg + '</div>' : '') +
          '<label class="input-label">Project URL</label>' +
          '<input id="cfgUrl" class="input-field" type="url" placeholder="https://xxxx.supabase.co" />' +
          '<label class="input-label">Publishable / anon key</label>' +
          '<input id="cfgKey" class="input-field" type="text" placeholder="sb_publishable_..." autocomplete="off" />' +
          '<button id="cfgSaveBtn" class="btn btn-primary btn-block" style="margin-top:16px">保存并连接</button>' +
          '<div class="login-tip">如已在 config.js 中填入参数，可忽略此步骤；此处填写会覆盖 config.js。</div>' +
        '</div>' +
      '</div>';
    document.getElementById('app').innerHTML = html;
    document.getElementById('cfgSaveBtn').addEventListener('click', function () {
      var url = document.getElementById('cfgUrl').value.trim();
      var key = document.getElementById('cfgKey').value.trim();
      if (!url || !key) { showConfigSetup('请填写 URL 和 key'); return; }
      if (!/^https:\/\//.test(url)) { showConfigSetup('URL 必须以 https:// 开头'); return; }
      // 拒绝 service_role / secret key 进入前端
      if (/service_role|sb_secret_/i.test(key)) {
        showConfigSetup('检测到 service_role / secret key，禁止在前端使用。请改用 publishable / anon key。');
        return;
      }
      saveConfigLocally(url, key);
      db = new SupabaseAdapter(url, key);
      bootstrap();
    });
  }

  function bootstrap() {
    var user = db.getCurrentUser();
    if (user) {
      state.user = user;
      afterLogin();
    } else {
      showLogin();
    }
  }

  // ---------- 登录 ----------
  var REMEMBER_KEY = 'kx_remembered_email';

  function showLogin(msg) {
    // 读取已记住的邮箱（仅邮箱，绝不存密码）
    var remembered = '';
    try { remembered = localStorage.getItem(REMEMBER_KEY) || ''; } catch (e) {}
    var html =
      '<div class="login-wrap">' +
        '<div class="login-card">' +
          '<div class="login-title">凯兴计件单价系统</div>' +
          '<div class="login-sub">浙江土畜凯兴 · 共享版（需登录）</div>' +
          (msg ? '<div class="login-err">' + msg + '</div>' : '') +
          '<label class="input-label">邮箱</label>' +
          '<input id="loginEmail" class="input-field" type="email" autocomplete="username" placeholder="your@email.com" value="' + (remembered ? remembered.replace(/"/g, '&quot;') : '') + '" />' +
          '<label class="input-label">密码</label>' +
          '<input id="loginPwd" class="input-field" type="password" autocomplete="current-password" placeholder="请输入密码" />' +
          '<label class="remember-row">' +
            '<input type="checkbox" id="rememberChk" ' + (remembered ? 'checked' : '') + ' />' +
            '<span>记住账号</span>' +
          '</label>' +
          '<button id="loginBtn" class="btn btn-login btn-block" style="margin-top:16px">登录</button>' +
          '<div class="login-tip">' + (CFG.USE_MOCK ? 'Mock 模式：邮箱含 admin 即为管理员，其余为只读账号，密码任意。' : '账号由管理员在 Supabase 后台创建，不开放自助注册。') + '</div>' +
          '<div style="text-align:center;margin-top:8px"><a href="#" id="reconfigLink" style="font-size:12px;color:#bbb;text-decoration:none">重新配置 Supabase</a></div>' +
        '</div>' +
      '</div>';
    document.getElementById('app').innerHTML = html;
    document.getElementById('loginBtn').addEventListener('click', doLogin);
    document.getElementById('loginPwd').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLogin();
    });
    // 取消勾选时立即清除已存邮箱
    document.getElementById('rememberChk').addEventListener('change', function (e) {
      if (!e.target.checked) {
        try { localStorage.removeItem(REMEMBER_KEY); } catch (err) {}
      }
    });
    document.getElementById('reconfigLink').addEventListener('click', function (e) {
      e.preventDefault();
      try { localStorage.removeItem('kx_supabase_config'); } catch (err) {}
      showConfigSetup();
    });
  }

  function doLogin() {
    var email = document.getElementById('loginEmail').value.trim();
    var pwd = document.getElementById('loginPwd').value;
    var remember = document.getElementById('rememberChk').checked;
    if (!email || !pwd) { showLogin('请输入邮箱和密码'); return; }
    var btn = document.getElementById('loginBtn');
    btn.textContent = '登录中...'; btn.disabled = true;
    db.signIn(email, pwd).then(function (res) {
      if (res.error) {
        showLogin('登录失败：' + (res.error.message || res.error));
        return;
      }
      // 仅记住邮箱，绝不存密码
      try {
        if (remember) localStorage.setItem(REMEMBER_KEY, email);
        else localStorage.removeItem(REMEMBER_KEY);
      } catch (err) {}
      state.user = db.getCurrentUser();
      afterLogin();
    }).catch(function (e) {
      showLogin('登录异常：' + e.message);
    });
  }

  function doLogout() {
    db.signOut().then(function () {
      state.user = null; state.role = null;
      state.unsub.forEach(function (u) { try { u(); } catch (e) {} });
      state.unsub = [];
      showLogin();
    });
  }

  function afterLogin() {
    db.getRole().then(function (role) {
      state.role = role || 'viewer';
      return Promise.all([db.listProcesses(), db.getSettings()]);
    }).then(function (results) {
      var pres = results[0], sres = results[1];
      if (pres.error) throw pres.error;
      if (sres.error) throw sres.error;
      state.processes = (pres.data || []).map(normProcess);
      state.settings = normSettings(sres.data);
      state.decimalPlaces = state.settings.decimalPlaces;
      state.efficiency = 1.0;
      setupRealtime();
      renderApp();
    }).catch(function (e) {
      showLogin('加载数据失败：' + (e.message || e));
    });
  }

  // ---------- 实时同步 + 轮询兜底 ----------
  function setupRealtime() {
    var onProc = function () { refreshProcesses(); };
    var onSet = function () { refreshSettings(); };
    state.unsub.push(db.subscribe('processes', onProc));
    state.unsub.push(db.subscribe('settings', onSet));
    // 轮询兜底：每 30 秒刷新一次，防止 realtime 断连
    state._poll = setInterval(function () {
      refreshProcesses(); refreshSettings();
    }, 30000);
  }

  function refreshProcesses() {
    db.listProcesses().then(function (res) {
      if (res.error) return;
      state.processes = (res.data || []).map(normProcess);
      if (state.tab === 'list') renderList();
      if (state.tab === 'batch') renderBatch();
    });
  }
  function refreshSettings() {
    db.getSettings().then(function (res) {
      if (res.error) return;
      state.settings = normSettings(res.data);
      state.decimalPlaces = state.settings.decimalPlaces;
      if (state.tab === 'settings') renderSettings();
      if (state.tab === 'list') renderList();
    });
  }

  // ---------- 主界面 ----------
  function renderApp() {
    var isAdmin = state.role === 'admin';
    var tabs = [
      { key: 'list', label: '工序' },
      { key: 'calc', label: '计算' },
      { key: 'batch', label: '批量' },
      { key: 'settings', label: '设置' }
    ];
    if (isAdmin) tabs.push({ key: 'history', label: '历史' });

    var html =
      '<div class="app">' +
        '<div class="hdr">' +
          '<div class="hdr-title">凯兴计件单价</div>' +
          '<div class="hdr-right">' +
            '<span class="role-tag ' + (isAdmin ? 'role-admin' : 'role-viewer') + '">' + (isAdmin ? '管理员' : '只读') + '</span>' +
            '<span class="hdr-email">' + (state.user ? state.user.email : '') + '</span>' +
            '<button class="btn btn-default btn-sm" id="logoutBtn">退出</button>' +
          '</div>' +
        '</div>' +
        '<div id="tabContent"></div>' +
      '</div>' +
      '<div class="tabbar">' +
        tabs.map(function (t) {
          return '<div class="tab ' + (state.tab === t.key ? 'active' : '') + '" data-tab="' + t.key + '" data-label="' + t.label + '">' + t.label + '</div>';
        }).join('') +
      '</div>';
    document.getElementById('app').innerHTML = html;
    document.getElementById('logoutBtn').addEventListener('click', doLogout);
    document.querySelectorAll('.tab').forEach(function (el) {
      el.addEventListener('click', function () { switchTab(el.dataset.tab); });
    });
    switchTab(state.tab);
  }

  function switchTab(tab) {
    state.tab = tab;
    document.querySelectorAll('.tab').forEach(function (el) {
      el.classList.toggle('active', el.dataset.tab === tab);
    });
    if (tab === 'list') renderList();
    else if (tab === 'calc') renderCalc();
    else if (tab === 'batch') renderBatch();
    else if (tab === 'settings') renderSettings();
    else if (tab === 'history') renderHistory();
  }

  // ---------- 工序列表 ----------
  function renderList() {
    var isAdmin = state.role === 'admin';
    var list = state.processes.filter(function (p) { return p.enabled; });
    var cats = [];
    state.processes.forEach(function (p) { if (cats.indexOf(p.category) === -1) cats.push(p.category); });

    var catBar = '<div class="cat-chip ' + (state.catFilter === '' ? 'active' : '') + '" data-cat="">全部</div>' +
      cats.map(function (c) {
        return '<div class="cat-chip ' + (state.catFilter === c ? 'active' : '') + '" data-cat="' + c + '">' + c + '</div>';
      }).join('');

    var filtered = list;
    if (state.catFilter) filtered = filtered.filter(function (p) { return p.category === state.catFilter; });
    var kw = state.keyword.trim().toLowerCase();
    if (kw) filtered = filtered.filter(function (p) {
      return (p.name || '').toLowerCase().indexOf(kw) !== -1 ||
        (p.category || '').toLowerCase().indexOf(kw) !== -1 ||
        String(p.code).indexOf(kw) !== -1;
    });

    var cards = filtered.length === 0
      ? '<div class="empty">未找到匹配的工序</div>'
      : filtered.map(function (p) {
          var r = Calc.calcProcess(p, { efficiency: state.efficiency, decimalPlaces: state.decimalPlaces });
          return '<div class="card" data-id="' + p.id + '">' +
            '<div class="row-head"><span class="row-id">#' + p.code + '</span><span class="tag">' + p.category + '</span>' +
            (p.netBagTime > 0 ? '<span class="tag tag-orange">含装网袋</span>' : '') +
            '<span class="row-price">¥' + r.totalPrice + '</span></div>' +
            '<div class="row-name">' + p.name + '</div>' +
            '<div class="row-meta">作业时间 ' + p.operationTime + ' 秒/把 · 计件 ¥' + r.piecePrice +
            (p.netBagTime > 0 ? ' · 装网袋 ¥' + r.netBagPrice : '') + '</div>' +
            (p.remarks ? '<div class="row-remark">备注：' + p.remarks + '</div>' : '') +
            '</div>';
        }).join('');

    var html =
      '<div class="card">' +
        '<div class="title">计件工时库</div>' +
        '<div class="subtitle">浙江土畜凯兴 · 2026版 / ' + (state.settings ? state.settings.defaultHourlyWage : 27) + '元工价 · 共 ' + state.processes.length + ' 道</div>' +
        '<input id="search" class="input-field" placeholder="搜索工序名 / 编号 / 大工序" value="' + state.keyword + '" />' +
        '<div id="catBar" class="cat-bar">' + catBar + '</div>' +
      '</div>' +
      '<div id="processList">' + cards + '</div>' +
      (isAdmin ? '<div class="fab" id="addFab">+ 新增工序</div>' : '');

    document.getElementById('tabContent').innerHTML = html;
    document.getElementById('search').addEventListener('input', function (e) { state.keyword = e.target.value; renderList(); });
    document.querySelectorAll('.cat-chip').forEach(function (el) {
      el.addEventListener('click', function () { state.catFilter = state.catFilter === el.dataset.cat ? '' : el.dataset.cat; renderList(); });
    });
    document.querySelectorAll('#processList .card').forEach(function (el) {
      el.addEventListener('click', function () { openCalc(el.dataset.id); });
    });
    if (isAdmin) document.getElementById('addFab').addEventListener('click', newProcess);
  }

  // ---------- 新增 / 编辑 工序 ----------
  function openCalc(id) {
    var p = state.processes.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    state.currentProcess = JSON.parse(JSON.stringify(p));
    state.currentOriginal = JSON.parse(JSON.stringify(p));
    state.isNew = false;
    state.quantity = 1;
    switchTab('calc');
  }

  function newProcess() {
    state.currentProcess = {
      id: null, code: '', category: '套咀', name: '',
      operationTime: 0, allowanceRate: state.settings ? state.settings.defaultAllowanceRate : 0.15,
      hourlyWage: state.settings ? state.settings.defaultHourlyWage : 27,
      netBagTime: 0, remarks: '', enabled: true
    };
    state.currentOriginal = JSON.parse(JSON.stringify(state.currentProcess));
    state.isNew = true;
    state.quantity = 1;
    switchTab('calc');
  }

  function renderCalc() {
    var p = state.currentProcess;
    var isAdmin = state.role === 'admin';
    if (!p) {
      document.getElementById('tabContent').innerHTML = '<div class="empty">请从工序列表选择一道工序</div>';
      return;
    }
    var r = Calc.calcProcess(p, { efficiency: state.efficiency, decimalPlaces: state.decimalPlaces });
    var totalWages = Calc.calcWages(r.totalPrice, state.quantity);

    var readOnly = isAdmin ? '' : 'readonly';
    var fieldInput = function (label, type, val, field, extra) {
      var t = type === 'digit' ? 'number' : 'text';
      var step = type === 'digit' ? 'step="0.0001"' : '';
      return '<label class="input-label">' + label + '</label>' +
        '<input class="input-field" type="' + t + '" value="' + val + '" data-field="' + field + '" ' + step + ' ' + readOnly + ' ' + (extra || '') + ' />';
    };

    var html = '<div class="card">' +
      '<div class="title">' + (p.name || '新工序') + '</div>' +
      '<div class="subtitle">编号 #' + p.code + ' · ' + p.category + (p.enabled === false ? ' · 已停用' : '') + '</div>' +
      fieldInput('工序 / 产品名称', 'text', p.name, 'name') +
      fieldInput('大工序', 'text', p.category, 'category') +
      fieldInput('编号（唯一）', 'digit', p.code, 'code', state.isNew ? '' : 'readonly') +
      fieldInput('作业时间（秒/把）', 'digit', p.operationTime, 'operationTime') +
      fieldInput('宽放率（如 0.15）', 'digit', p.allowanceRate, 'allowanceRate') +
      fieldInput('时薪（元/H）', 'digit', p.hourlyWage, 'hourlyWage') +
      fieldInput('装网袋时间（秒/把，无则填 0）', 'digit', p.netBagTime, 'netBagTime') +
      fieldInput('备注', 'text', p.remarks, 'remarks') +
      '</div>' +
      '<div class="card total-card">' +
      '<div class="subtitle">合计计件单价</div>' +
      '<div class="price-big">¥' + r.totalPrice + '<span class="price-unit">元/把</span></div>' +
      '<div class="result-grid">' +
      cell('标准工时', r.standardTime + ' 秒') + cell('计件单价', '¥' + r.piecePrice) + cell('装网袋单价', '¥' + r.netBagPrice) +
      '</div>' +
      '<div class="subtitle" style="margin-top:14px">计算过程</div>' +
      '<div class="formula">标准工时 = ' + r.formulaParts.standardTime + '</div>' +
      '<div class="formula">计件单价 = ' + r.formulaParts.piecePrice + '</div>' +
      '<div class="formula">装网袋单价 = ' + r.formulaParts.netBagPrice + '</div>' +
      '<div class="formula">合计单价 = ' + r.formulaParts.totalPrice + '</div>' +
      '</div>' +
      '<div class="card">' +
      '<label class="input-label">效率 / 难度系数（默认 1.0，仅本地试算）</label>' +
      '<input id="calcEff" class="input-field" type="number" step="0.01" value="' + state.efficiency + '" />' +
      '<label class="input-label">件数（把）</label>' +
      '<input id="calcQty" class="input-field" type="number" value="' + state.quantity + '" />' +
      '<div class="wages-row"><span>总工资</span><span class="wages-val">¥' + totalWages + '</span></div>' +
      '</div>';

    if (isAdmin) {
      html += '<div class="btn-group"><button class="btn btn-default" id="cancelBtn">取消 / 恢复</button>' +
        '<button class="btn btn-primary" id="saveBtn">' + (state.isNew ? '保存新增' : '保存修改') + '</button></div>';
      if (!state.isNew) {
        html += '<div class="btn-group"><button class="btn btn-warn" id="toggleEnBtn">' + (p.enabled === false ? '启用' : '停用') + '</button>' +
          '<button class="btn btn-danger" id="delBtn">删除工序</button></div>';
      }
    } else {
      html += '<div class="note" style="padding:10px;color:#888">只读模式：可调整效率系数与件数进行试算，不会写入数据库。</div>';
    }

    document.getElementById('tabContent').innerHTML = html;
    document.querySelectorAll('#tabContent .input-field').forEach(function (inp) {
      inp.addEventListener('input', function () {
        var f = inp.dataset.field;
        if (f) updateField(f, inp.value);
      });
    });
    document.getElementById('calcEff').addEventListener('input', function (e) {
      var v = parseFloat(e.target.value);
      state.efficiency = isNaN(v) ? 1 : v;
      renderCalc();
    });
    document.getElementById('calcQty').addEventListener('input', function (e) {
      state.quantity = parseInt(e.target.value) || 0;
      renderCalc();
    });
    if (isAdmin) {
      document.getElementById('cancelBtn').addEventListener('click', cancelEdit);
      document.getElementById('saveBtn').addEventListener('click', saveEdit);
      if (!state.isNew) {
        document.getElementById('toggleEnBtn').addEventListener('click', toggleEnabled);
        document.getElementById('delBtn').addEventListener('click', deleteProcess);
      }
    }
  }

  function cell(label, val) {
    return '<div class="result-cell"><div class="cell-label">' + label + '</div><div class="cell-val">' + val + '</div></div>';
  }

  function updateField(field, raw) {
    var p = state.currentProcess;
    if (field === 'name' || field === 'category' || field === 'remarks') {
      p[field] = raw;
    } else {
      var num = parseFloat(raw);
      p[field] = isNaN(num) ? 0 : num;
    }
    renderCalc();
  }

  function cancelEdit() {
    state.currentProcess = JSON.parse(JSON.stringify(state.currentOriginal));
    alert('已恢复');
    renderCalc();
  }

  function saveEdit() {
    var p = state.currentProcess;
    if (!p.name || !String(p.name).trim()) { alert('请填写工序名称'); return; }
    if (!p.code || Number(p.code) <= 0) { alert('请填写有效的编号'); return; }
    var btn = document.getElementById('saveBtn');
    btn.textContent = '保存中...'; btn.disabled = true;
    var promise = state.isNew
      ? db.createProcess(p)
      : db.updateProcess(p.id, p);
    promise.then(function (res) {
      if (res.error) { alert('保存失败：' + (res.error.message || res.error)); btn.textContent = state.isNew ? '保存新增' : '保存修改'; btn.disabled = false; return; }
      alert('已保存');
      refreshProcesses();
      state.currentProcess = null;
      state.isNew = false;
      switchTab('list');
    });
  }

  function toggleEnabled() {
    var p = state.currentProcess;
    var newVal = p.enabled === false;
    if (!confirm('确定' + (newVal ? '启用' : '停用') + '该工序？')) return;
    db.updateProcess(p.id, { enabled: newVal }).then(function (res) {
      if (res.error) { alert('操作失败：' + (res.error.message || res.error)); return; }
      alert('已' + (newVal ? '启用' : '停用'));
      refreshProcesses();
      switchTab('list');
    });
  }

  function deleteProcess() {
    if (!confirm('确定删除该工序？此操作不可撤销。')) return;
    db.deleteProcess(state.currentProcess.id).then(function (res) {
      if (res.error) { alert('删除失败：' + (res.error.message || res.error)); return; }
      alert('已删除');
      state.currentProcess = null;
      refreshProcesses();
      switchTab('list');
    });
  }

  // ---------- 批量 ----------
  function renderBatch() {
    var isAdmin = state.role === 'admin';
    var list = state.processes.filter(function (p) { return p.enabled; });
    var html = '<div class="card"><div class="title">多工序合计</div>' +
      '<div class="subtitle">勾选工序合计单件工资' + (isAdmin ? '；管理员可批量调价' : '（只读）') + '</div>' +
      '<div class="select-all" id="selectAllText">全选（已选 ' + state.selectedIds.length + ' / ' + list.length + '）</div>' +
      '</div>';
    html += '<div id="batchList">' + list.map(function (p) {
      var checked = state.selectedIds.indexOf(p.id) >= 0;
      return '<div class="card" data-id="' + p.id + '">' +
        '<div class="check-row"><div class="checkbox ' + (checked ? 'checked' : '') + '"></div>' +
        '<div style="flex:1"><div class="row-name">' + p.name + '</div>' +
        '<div class="row-meta">#' + p.code + ' · ' + p.category + '</div></div></div></div>';
    }).join('') + '</div>';

    var selected = list.filter(function (p) { return state.selectedIds.indexOf(p.id) !== -1; });
    var res = Calc.calcTotal(selected, { efficiency: state.efficiency, decimalPlaces: state.decimalPlaces });
    var wages = Calc.calcWages(res.totalPrice, state.batchQty);
    html += '<div class="card total-card">' +
      '<div class="subtitle">合计单件工资</div>' +
      '<div class="price-big" id="batchTotal">¥' + res.totalPrice + '<span class="price-unit">元/把</span></div>' +
      '<div id="batchDetails">' + res.details.map(function (d) {
        return '<div class="total-detail"><span>' + d.name + '</span><span class="detail-price">¥' + d.totalPrice + '</span></div>';
      }).join('') + '</div>' +
      '<div class="qty-row"><span class="input-label">件数（把）</span>' +
      '<input id="batchQty" class="input-field" type="number" value="' + state.batchQty + '" style="flex:1" /></div>' +
      '<div class="wages-row"><span>总工资</span><span class="wages-val" id="batchWages">¥' + wages + '</span></div>' +
      '</div>';

    if (isAdmin) {
      html += '<div class="card"><div class="title">批量调价（按百分比）</div>' +
        '<div class="subtitle">对已勾选工序的时薪按百分比调整，单价自动重算</div>' +
        '<div class="adjust-row">' +
        '<input id="adjustPct" class="input-field" type="number" placeholder="如 10 表示+10%，-5 表示-5%" style="flex:1" />' +
        '<span class="adjust-pct">%</span></div>' +
        '<button class="btn btn-primary btn-block" id="applyAdjBtn">应用调价到已选 ' + selected.length + ' 道工序</button>' +
        '</div>';
    }

    document.getElementById('tabContent').innerHTML = html;
    document.getElementById('selectAllText').addEventListener('click', function () {
      if (state.selectedIds.length === list.length) state.selectedIds = [];
      else state.selectedIds = list.map(function (p) { return p.id; });
      renderBatch();
    });
    document.querySelectorAll('#batchList .card').forEach(function (el) {
      el.addEventListener('click', function () {
        var id = el.dataset.id;
        var i = state.selectedIds.indexOf(id);
        if (i >= 0) state.selectedIds.splice(i, 1); else state.selectedIds.push(id);
        renderBatch();
      });
    });
    document.getElementById('batchQty').addEventListener('input', function (e) {
      state.batchQty = parseInt(e.target.value) || 0;
      renderBatch();
    });
    if (isAdmin) {
      document.getElementById('applyAdjBtn').addEventListener('click', applyBatchAdjust);
    }
  }

  function applyBatchAdjust() {
    var pct = parseFloat(document.getElementById('adjustPct').value);
    if (isNaN(pct) || pct === 0) { alert('请输入调价百分比'); return; }
    var list = state.processes.filter(function (p) { return state.selectedIds.indexOf(p.id) !== -1; });
    if (list.length === 0) { alert('请先勾选工序'); return; }
    if (!confirm('将对 ' + list.length + ' 道工序的时薪 ' + (pct > 0 ? '上调' : '下调') + ' ' + Math.abs(pct) + '%，确定？')) return;
    var factor = 1 + pct / 100;
    var todo = list.map(function (p) {
      return db.updateProcess(p.id, { hourlyWage: Calc.round((Number(p.hourlyWage) || 0) * factor, 4) });
    });
    Promise.all(todo).then(function (results) {
      var fail = results.filter(function (r) { return r.error; });
      alert(fail.length ? '部分失败：' + fail.length + ' 道' : '调价完成');
      refreshProcesses();
      renderBatch();
    });
  }

  // ---------- 设置 ----------
  function renderSettings() {
    var isAdmin = state.role === 'admin';
    var s = state.settings || { defaultHourlyWage: 27, defaultAllowanceRate: 0.15, decimalPlaces: 4 };
    var ro = isAdmin ? '' : 'readonly';
    var html = '<div class="card"><div class="title">全局参数</div>' +
      '<div class="subtitle">' + (isAdmin ? '仅管理员可修改，改动实时同步' : '只读') + '</div>' +
      '<label class="input-label">默认时薪（元/H）</label>' +
      '<input id="setWage" class="input-field" type="number" step="0.01" value="' + s.defaultHourlyWage + '" ' + ro + ' />' +
      '<label class="input-label">默认宽放率（如 0.15）</label>' +
      '<input id="setAllow" class="input-field" type="number" step="0.0001" value="' + s.defaultAllowanceRate + '" ' + ro + ' />' +
      '<label class="input-label">结果小数位数（0-6）</label>' +
      '<input id="setDec" class="input-field" type="number" min="0" max="6" value="' + s.decimalPlaces + '" ' + ro + ' />';
    if (isAdmin) {
      html += '<button class="btn btn-primary btn-block" id="saveSetBtn" style="margin-top:14px">保存全局参数</button>';
    }
    html += '</div>';

    html += '<div class="card"><div class="title">说明</div>' +
      '<div class="note">· 单价单位为「元/把」，1 把 = 90 米。</div>' +
      '<div class="note">· 所有数据存储在 Supabase，多端实时同步。</div>' +
      '<div class="note">· 改价历史由数据库自动记录，管理员可在「历史」页查看。</div>' +
      '<div class="note">· 当前模式：' + (CFG.USE_MOCK ? 'Mock（本地模拟，不连真实 Supabase）' : 'Supabase 云端') + '</div>' +
      '</div>';

    document.getElementById('tabContent').innerHTML = html;
    if (isAdmin) {
      document.getElementById('saveSetBtn').addEventListener('click', function () {
        var patch = {
          defaultHourlyWage: parseFloat(document.getElementById('setWage').value) || 27,
          defaultAllowanceRate: parseFloat(document.getElementById('setAllow').value) || 0.15,
          decimalPlaces: Math.max(0, Math.min(6, parseInt(document.getElementById('setDec').value) || 4))
        };
        db.updateSettings(patch).then(function (res) {
          if (res.error) { alert('保存失败：' + (res.error.message || res.error)); return; }
          alert('已保存，所有在线用户将自动同步');
          refreshSettings();
        });
      });
    }
  }

  // ---------- 改价历史（仅 admin） ----------
  function renderHistory() {
    var html = '<div class="card"><div class="title">改价历史</div>' +
      '<div class="subtitle">由数据库自动记录，管理员可查看</div>' +
      '<button class="btn btn-default" id="refreshHistBtn">刷新</button></div>' +
      '<div id="histList"><div class="empty">加载中...</div></div>';
    document.getElementById('tabContent').innerHTML = html;
    document.getElementById('refreshHistBtn').addEventListener('click', loadHistory);
    loadHistory();
  }

  function loadHistory() {
    db.listHistory(200).then(function (res) {
      if (res.error) {
        document.getElementById('histList').innerHTML = '<div class="empty">加载失败：' + (res.error.message || res.error) + '</div>';
        return;
      }
      var rows = res.data || [];
      if (rows.length === 0) {
        document.getElementById('histList').innerHTML = '<div class="empty">暂无改价记录</div>';
        return;
      }
      var fieldLabels = {
        operationTime: '作业时间', allowanceRate: '宽放率', hourlyWage: '时薪',
        netBagTime: '装网袋时间', name: '名称', category: '大工序',
        enabled: '启用状态', remarks: '备注', create: '创建', delete: '删除'
      };
      document.getElementById('histList').innerHTML = rows.map(function (h) {
        return '<div class="card hist-row">' +
          '<div class="row-head"><span class="row-id">#' + (h.process_code || '-') + '</span>' +
          '<span class="tag">' + (fieldLabels[h.field_name] || h.field_name) + '</span>' +
          '<span class="row-price" style="font-size:13px">' + (h.changed_at || '').slice(0, 19).replace('T', ' ') + '</span></div>' +
          '<div class="row-name">' + (h.process_name || '（已删除）') + '</div>' +
          '<div class="row-meta">旧值：' + (h.old_value === null ? '—' : h.old_value) +
          ' → 新值：' + (h.new_value === null ? '—' : h.new_value) + '</div>' +
          '<div class="row-meta">修改人：' + (h.changed_by_email || '未知') + '</div>' +
          '</div>';
      }).join('');
    });
  }

  // ---------- 启动 ----------
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
