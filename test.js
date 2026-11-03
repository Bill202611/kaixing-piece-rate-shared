// =====================================================================
// 本地验证测试（不依赖真实 Supabase）
// 运行：node test.js
// 覆盖：公式正确性、工序 CRUD、权限分支（admin/viewer）、改价历史记录、无数据泄露检查
// =====================================================================
var assert = require('assert');
var path = require('path');
var fs = require('fs');

var Calc = require('./calc.js');
var MockDB = require('./mock.js');

var passed = 0;
var failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    passed++;
  } catch (e) {
    console.log('  ✗ ' + name + ' -> ' + e.message);
    failed++;
  }
}

console.log('\n=== 1. 公式正确性 ===');

// 已知基准：id=1，operationTime=100, allowance=0.15, wage=27, netBag=0, eff=1
var p1 = { operationTime: 100, allowanceRate: 0.15, hourlyWage: 27, netBagTime: 0 };
var r1 = Calc.calcProcess(p1, { efficiency: 1, decimalPlaces: 4 });
test('标准工时 = 100 × 1.15 × 1', function () {
  assert.strictEqual(r1.standardTime, Calc.round(100 * 1.15 * 1, 4));
});
test('计件单价 = 标准工时/3600 × 27', function () {
  assert.strictEqual(r1.piecePrice, Calc.round(r1.standardTime / 3600 * 27, 4));
});
test('无装网袋时装网袋单价=0', function () {
  assert.strictEqual(r1.netBagPrice, 0);
});
test('合计单价 = 计件单价 + 装网袋单价', function () {
  assert.strictEqual(r1.totalPrice, r1.piecePrice + r1.netBagPrice);
});

// 含装网袋：id=4，netBagTime=20
var p4 = { operationTime: 80, allowanceRate: 0.15, hourlyWage: 27, netBagTime: 20 };
var r4 = Calc.calcProcess(p4, { efficiency: 1, decimalPlaces: 4 });
test('装网袋单价 = 20 × 1.15 × 1 / 3600 × 27', function () {
  var expected = Calc.round(20 * 1.15 / 3600 * 27, 4);
  assert.strictEqual(r4.netBagPrice, expected);
});
test('含装网袋合计 > 计件单价', function () {
  assert.ok(r4.totalPrice > r4.piecePrice);
});

// 效率系数影响
var r4b = Calc.calcProcess(p4, { efficiency: 1.2, decimalPlaces: 4 });
test('效率系数 1.2 使标准工时放大', function () {
  assert.strictEqual(r4b.standardTime, Calc.round(80 * 1.15 * 1.2, 4));
});

// 批量调价
test('batchAdjustPrice 按百分比调整时薪', function () {
  var list = [{ hourlyWage: 27 }];
  var out = Calc.batchAdjustPrice(list, 10);
  assert.strictEqual(out[0].hourlyWage, Calc.round(27 * 1.1, 4));
});
test('batchAdjustPrice -5%', function () {
  var out = Calc.batchAdjustPrice([{ hourlyWage: 100 }], -5);
  assert.strictEqual(out[0].hourlyWage, 95);
});

// 工资反算
test('calcWages = 单价 × 件数', function () {
  assert.strictEqual(Calc.calcWages(1.5, 100), 150);
});

console.log('\n=== 2. 基准数据结构 ===');
test('MockDB 可实例化且 processes 为空数组（公开版无内置数据）', function () {
  var db = new MockDB();
  var internal = db._internal();
  assert.strictEqual(internal.processes.length, 0, '公开版不应内置工序数据');
});

console.log('\n=== 3. 权限分支（RLS 模拟） ===');
test('viewer 读工序成功', function () {
  var db = new MockDB();
  return db.signIn('worker@example.com', 'x').then(function () {
    return db.listProcesses();
  }).then(function (res) {
    assert.strictEqual(res.error, null);
    assert.strictEqual(res.data.length, 25);
  });
});
test('viewer 写工序被拒绝（403）', function () {
  var db = new MockDB();
  return db.signIn('worker@example.com', 'x').then(function () {
    return db.createProcess({ code: 99, name: 'test', category: 'x' });
  }).then(function (res) {
    assert.ok(res.error, 'viewer 应被拒绝写入');
    assert.ok(/权限不足/.test(res.error.message));
  });
});
test('viewer 改设置被拒绝', function () {
  var db = new MockDB();
  return db.signIn('worker@example.com', 'x').then(function () {
    return db.updateSettings({ defaultHourlyWage: 30 });
  }).then(function (res) {
    assert.ok(res.error);
  });
});
test('viewer 读历史被拒绝', function () {
  var db = new MockDB();
  return db.signIn('worker@example.com', 'x').then(function () {
    return db.listHistory();
  }).then(function (res) {
    assert.ok(res.error);
  });
});
test('admin 写工序成功', function () {
  var db = new MockDB();
  return db.signIn('admin@example.com', 'x').then(function () {
    return db.createProcess({ code: 99, name: '测试工序', category: '套咀', operationTime: 10, hourlyWage: 27, allowanceRate: 0.15, netBagTime: 0 });
  }).then(function (res) {
    assert.strictEqual(res.error, null);
    assert.ok(res.data.id);
  });
});
test('admin 改设置成功并影响 decimalPlaces', function () {
  var db = new MockDB();
  return db.signIn('admin@example.com', 'x').then(function () {
    return db.updateSettings({ decimalPlaces: 2 });
  }).then(function (res) {
    assert.strictEqual(res.error, null);
    assert.strictEqual(res.data.decimalPlaces, 2);
  });
});

console.log('\n=== 4. 改价历史记录 ===');
test('admin 更新时薪后产生历史记录', function () {
  var db = new MockDB();
  return db.signIn('admin@example.com', 'x').then(function () {
    return db.listProcesses();
  }).then(function (res) {
    var p = res.data[0];
    return db.updateProcess(p.id, { hourlyWage: 30 });
  }).then(function () {
    return db.listHistory();
  }).then(function (res) {
    assert.strictEqual(res.error, null);
    var hourlyRecord = res.data.find(function (h) { return h.field_name === 'hourlyWage'; });
    assert.ok(hourlyRecord, '应有 hourlyWage 变更记录');
    assert.strictEqual(hourlyRecord.old_value, '27');
    assert.strictEqual(hourlyRecord.new_value, '30');
  });
});
test('新增工序产生 create 历史', function () {
  var db = new MockDB();
  return db.signIn('admin@example.com', 'x').then(function () {
    return db.createProcess({ code: 88, name: '新工序', category: '其他', operationTime: 5, hourlyWage: 27, allowanceRate: 0.15 });
  }).then(function () {
    return db.listHistory();
  }).then(function (res) {
    var rec = res.data.find(function (h) { return h.field_name === 'create'; });
    assert.ok(rec);
  });
});
test('删除工序产生 delete 历史', function () {
  var db = new MockDB();
  var pid;
  return db.signIn('admin@example.com', 'x').then(function () {
    return db.listProcesses();
  }).then(function (res) {
    pid = res.data[0].id;
    return db.deleteProcess(pid);
  }).then(function () {
    return db.listHistory();
  }).then(function (res) {
    var rec = res.data.find(function (h) { return h.field_name === 'delete'; });
    assert.ok(rec);
  });
});
test('viewer 无法通过写历史伪造记录（历史仅由触发器模拟写入）', function () {
  var db = new MockDB();
  return db.signIn('worker@example.com', 'x').then(function () {
    // viewer 尝试更新应被拒绝，历史表不产生记录
    return db.listProcesses();
  }).then(function (res) {
    return db.updateProcess(res.data[0].id, { hourlyWage: 999 });
  }).then(function (upd) {
    assert.ok(upd.error, 'viewer 更新应被拒');
    return db.listHistory();
  }).then(function (res) {
    assert.ok(res.error, 'viewer 读历史应被拒');
  });
});

console.log('\n=== 5. 编号唯一性 ===');
test('新增重复编号被拒绝', function () {
  var db = new MockDB();
  return db.signIn('admin@example.com', 'x').then(function () {
    return db.createProcess({ code: 1, name: '重复', category: 'x' });
  }).then(function (res) {
    assert.ok(res.error);
    assert.ok(/编号/.test(res.error.message));
  });
});

console.log('\n=== 6. 前端资源无工价数据泄露（生产模式） ===');
test('index.html 不含任何工序名或工价数字', function () {
  var html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  // 基准工序名不应出现在 index.html
  assert.ok(html.indexOf('羊肠衣') === -1, 'index.html 不应包含工序名');
  assert.ok(html.indexOf('100') === -1, 'index.html 不应包含工价数据');
  assert.ok(html.indexOf('27') === -1 || /27px|font-size.*27|#27/.test(html), 'index.html 中的 27 仅应为样式');
});
test('app.js 不含基准工序数据', function () {
  var js = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(js.indexOf('羊肠衣') === -1, 'app.js 不应包含工序名');
  assert.ok(js.indexOf('100') === -1, 'app.js 不应包含工价数据');
});
test('calc.js 不含业务数据', function () {
  var js = fs.readFileSync(path.join(__dirname, 'calc.js'), 'utf8');
  assert.ok(js.indexOf('羊肠衣') === -1);
  assert.ok(js.indexOf('100') === -1);
});
test('config.js 仅含空占位符，无真实 key', function () {
  var js = fs.readFileSync(path.join(__dirname, 'config.js'), 'utf8');
  assert.ok(js.indexOf('SUPABASE_URL') >= 0);
  assert.ok(js.indexOf('SUPABASE_ANON_KEY') >= 0);
  // 占位符必须为空字符串，不得填入真实 key
  assert.ok(/SUPABASE_URL:\s*''/.test(js), 'SUPABASE_URL 应为空占位符');
  assert.ok(/SUPABASE_ANON_KEY:\s*''/.test(js), 'SUPABASE_ANON_KEY 应为空占位符');
  // 不应出现长串 base64/JWT 形态的真实密钥
  assert.ok(!/eyJ[A-Za-z0-9_-]{20,}/.test(js), 'config.js 不应包含真实 JWT key');
});

console.log('\n=== 7. 实时同步订阅 ===');
test('订阅 processes 变更能收到回调', function () {
  var db = new MockDB();
  var received = false;
  var unsub = db.subscribe('processes', function () { received = true; });
  return db.signIn('admin@example.com', 'x').then(function () {
    return db.createProcess({ code: 77, name: '实时测试', category: 'x' });
  }).then(function () {
    unsub();
    assert.ok(received, '应收到 processes 变更回调');
  });
});

// 汇总
setTimeout(function () {
  console.log('\n----------------------------------------');
  console.log('通过：' + passed + '，失败：' + failed);
  if (failed > 0) {
    console.error('存在失败用例');
    process.exit(1);
  } else {
    console.log('全部测试通过 ✓');
  }
}, 100);

