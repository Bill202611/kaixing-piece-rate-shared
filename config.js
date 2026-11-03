// =====================================================================
// 配置文件 —— Supabase 参数占位符
// 安全策略：不在源码中写入任何密钥。
//   - 若在此处填入 SUPABASE_URL / SUPABASE_ANON_KEY，则直接使用；
//   - 若留空，应用启动时会提示在浏览器本地填入，存入 localStorage（永不写入源码）。
// 绝不要把 service_role / secret key 放入此处或任何前端文件。
// =====================================================================
window.KX_CONFIG = {
  // Supabase 项目根 URL（不要带 /rest/v1/ 等后缀）；留空则在浏览器内填写
  SUPABASE_URL: '',
  // Supabase publishable / anon public key；留空则在浏览器内填写
  SUPABASE_ANON_KEY: '',
  // 生产环境设为 false，连接真实 Supabase
  USE_MOCK: false
};
