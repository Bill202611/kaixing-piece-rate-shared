// =====================================================================
// 部署时生成 runtime-config.js 的脚本
// 用法（在 h5-shared 目录下执行）：
//   set SUPABASE_URL=https://xxxx.supabase.co
//   set SUPABASE_ANON_KEY=sb_publishable_...
//   node gen-runtime-config.js
// 或 Linux/macOS：
//   SUPABASE_URL=https://xxxx.supabase.co SUPABASE_ANON_KEY=sb_publishable_... node gen-runtime-config.js
// 生成的 runtime-config.js 会被 .gitignore 忽略，不进入仓库历史。
// =====================================================================
var fs = require('fs');
var path = require('path');

var url = process.env.SUPABASE_URL;
var key = process.env.SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('错误：请设置环境变量 SUPABASE_URL 和 SUPABASE_ANON_KEY');
  console.error('示例：set SUPABASE_URL=https://xxxx.supabase.co && set SUPABASE_ANON_KEY=sb_publishable_xxx && node gen-runtime-config.js');
  process.exit(1);
}

// 基本校验
if (!/^https:\/\//.test(url)) {
  console.error('错误：SUPABASE_URL 必须以 https:// 开头');
  process.exit(1);
}
if (/service_role|sb_secret_/i.test(key)) {
  console.error('错误：检测到 service_role / secret key，禁止写入前端。请使用 publishable / anon key。');
  process.exit(1);
}

var content =
  '// 部署时自动生成，请勿提交到仓库（见 .gitignore）\n' +
  '// 覆盖 config.js 中的占位符，使访客打开页面直接进入登录页\n' +
  'window.KX_CONFIG.SUPABASE_URL = ' + JSON.stringify(url) + ';\n' +
  'window.KX_CONFIG.SUPABASE_ANON_KEY = ' + JSON.stringify(key) + ';\n';

var outPath = path.join(__dirname, 'runtime-config.js');
fs.writeFileSync(outPath, content, 'utf8');
console.log('已生成 runtime-config.js -> ' + outPath);
console.log('URL: ' + url);
console.log('key 前缀: ' + key.substring(0, 16) + '...');
