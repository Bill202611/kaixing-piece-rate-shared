# 凯兴计件单价系统 · 共享版

纯静态前端 + Supabase（Auth + Postgres + Realtime）。登录后才能查看工时/工价；管理员可维护工序和价格，普通账号只读；管理员改价后其他在线用户自动看到最新数据；保留改价记录。

> 本目录为新建独立目录，**不修改**原始 `h5/` 和 Excel。

## 文件清单

| 文件 | 说明 |
|------|------|
| `index.html` | 登录页 + 主界面（不含任何工价数据） |
| `config.js` | Supabase 参数占位符（留空，密钥在浏览器本地填入，不落盘） |
| `calc.js` | 计件单价计算公式（纯逻辑，无业务数据） |
| `app.js` | 应用主逻辑：登录、权限、工序 CRUD、设置、计算器、批量调价、实时同步、历史 |
| `mock.js` | 本地 mock 数据层（仅 `USE_MOCK=true` 时加载，含 25 道基准工序用于本地验证） |
| `setup.sql` | **一键安装脚本**（合并 schema + seed，幂等，直接粘贴到 SQL Editor 执行） |
| `schema.sql` | 数据库结构：表、索引、`is_admin()`、RLS 策略、改价历史触发器（与 seed 拆开的版本） |
| `seed.sql` | 初始数据：25 道工序 + 全局参数（时薪 27、宽放率 0.15） |
| `test.js` | 本地测试：公式、权限分支、历史、数据泄露检查 |
| `README.md` | 本文档 |

## 一、Supabase 项目创建

1. 打开 https://supabase.com ，登录后点 **New project**
2. 填写项目名、数据库密码（请妥善保存），选择区域，创建
3. 进入项目后，左侧 **Project Settings → API**，复制两个值：
   - **Project URL**（形如 `https://xxxx.supabase.co`）
   - **anon public** key（`eyJ...` 开头的长字符串）

## 二、执行数据库 SQL

在 Supabase 左侧 **SQL Editor** 中，**直接粘贴 `setup.sql` 的全部内容并执行**即可（已合并表结构、函数、RLS、触发器、Realtime 发布和 25 道初始工序数据）。

> `setup.sql` 为幂等脚本（`if not exists` / `on conflict` / `drop ... if exists`），可重复执行不报错。如需分步执行，也可依次运行 `schema.sql` 再 `seed.sql`。

## 三、关闭公开注册（必须）

> ⚠️ 若不关闭，任何人拿到 `anon key` 都可自行注册账号并读取全部工序/工价数据。

1. Supabase 左侧 **Authentication → Providers → Email**
2. 关闭 **Confirm email**（可选），并确保没有开启自助注册入口
3. 更严格的做法：**Authentication → Providers**，把 Email provider 的 **Enable signups** 关闭
   - （不同版本 Supabase 菜单位置略有差异，核心是禁止 `signUp`）
4. 关闭后，账号只能由管理员在 **Authentication → Users** 中手动 **Add user** 创建

## 四、创建管理员账号

1. Supabase 左侧 **Authentication → Users → Add user**
   - 填写管理员邮箱和密码，创建
2. 复制该用户的 **User UID**
3. 在 **SQL Editor** 执行（把 `<管理员UID>` 替换为上一步的 UID）：

```sql
insert into public.user_roles (user_id, role)
values ('<管理员UID>', 'admin')
on conflict (user_id) do update set role = 'admin';
```

4. 普通只读账号：同样在 Users 中创建，**不要**在 `user_roles` 中插入记录（默认即为 viewer），或显式插入 `role='viewer'`。

## 五、前端连接配置（密钥不落盘）

为避免将密钥写入源码仓库，`config.js` 中的 `SUPABASE_URL` 和 `SUPABASE_ANON_KEY` 保持留空。应用启动时会自动弹出配置表单：

1. 打开部署后的页面
2. 在「Supabase 连接配置」表单中填入：
   - **Project URL**：`https://wklzvxntzmesbhsowkjv.supabase.co`（注意不要带 `/rest/v1/` 后缀）
   - **Publishable / anon key**：你的 publishable key（`sb_publishable_...` 开头）
3. 点击「保存并连接」——密钥存入本机浏览器 `localStorage`，**不会写入源码或上传服务器**

> 🔒 仅使用 `publishable` / `anon public` key，**绝不要**使用 `service_role` / `secret` key。应用会在前端主动拒绝 `sb_secret_` / `service_role` 形态的密钥。
>
> 若团队多台设备使用，每台设备首次打开时填入一次即可；也可直接在 `config.js` 中填入（但会随仓库分发，安全性降低）。

**清除本地配置**：在浏览器开发者工具 Console 执行 `localStorage.removeItem('kx_supabase_config')`。

## 六、本地预览

在本目录启动任意静态服务器，例如：

```bash
npx serve .
# 或
python -m http.server 8080
```

浏览器打开 `http://localhost:8080`，用管理员邮箱登录。

**本地验证（无需真实 Supabase）**：把 `config.js` 的 `USE_MOCK` 设为 `true`，用含 `admin` 的邮箱登录即为管理员（如 `admin@test.com`），其他邮箱为只读账号，密码任意。

## 七、部署到 GitHub Pages

1. 在 GitHub 创建一个仓库（公开或私有均可）
2. 把 `h5-shared/` 目录下所有文件推送到仓库根目录（或 `docs/` 子目录）
3. 仓库 **Settings → Pages**，Source 选 `Deploy from a branch`，分支选 `main`，目录选 `/ (root)` 或 `/docs`
4. 保存后等待部署，访问 `https://<你的用户名>.github.io/<仓库名>/`
5. 在 Supabase 左侧 **Authentication → URL Configuration**，把 Site URL 设为你的 GitHub Pages 地址

> GitHub Pages 为纯静态托管，适合本项目。也可部署到 Vercel、Netlify、Cloudflare Pages 等任意静态托管平台。

## 八、权限与安全边界

| 角色 | 工序 | 全局参数 | 批量调价 | 改价历史 | 计算器试算 |
|------|------|----------|----------|----------|------------|
| admin | 增删改查、停用/启用 | 可改 | 可执行 | 可查看 | 可 |
| viewer | 只读 | 只读 | 只读合计 | 不可见 | 可（效率/件数仅存本地） |

- **RLS 强制**：`processes` 仅 authenticated 可读、仅 admin 可写；`settings` 仅 admin 可改；`price_history` 仅 admin 可读，且**无任何写策略**——历史由数据库 `SECURITY DEFINER` 触发器自动写入，前端无法伪造。
- **数据不落前端**：`index.html`、`app.js`、`calc.js`、`config.js` 均不含任何工序或工价数据（已通过测试验证）。`mock.js` 含基准数据但**仅在 `USE_MOCK=true` 时加载**，生产部署前务必设为 `false`。
- **密钥不落源码**：Supabase URL 与 publishable key 不写入 `config.js`，由用户在浏览器本地填入并存入 `localStorage`，避免随仓库分发泄露。
- **Realtime**：已在 `schema.sql` 中把 `processes`、`settings` 加入 `supabase_realtime` 发布，前端订阅后变更自动刷新；另有 30 秒轮询兜底。
- **固定公网地址无内置访问控制**：部署后所有拿到链接的人都能看到登录页，但**未登录无法获取任何工价数据**（RLS 保证）。请妥善管理账号。

## 九、本地验证命令

```bash
# 语法检查所有 JS
node --check config.js
node --check calc.js
node --check mock.js
node --check app.js
node --check test.js

# 运行功能测试（公式、权限、历史、数据泄露）
node test.js
```

> 若本机无 node，可用任意 V8/JS 运行时加载 `calc.js` 与 `mock.js` 执行 `test.js` 中的断言。

## 十、未验证项

- Supabase SQL（`setup.sql`）尚未在云端执行，表结构与 RLS 需执行后实测。
- 尚未创建管理员账号并完成真实登录联调。
- Realtime 推送在真实 Supabase 中的表现待执行 SQL 后联调确认；30 秒轮询兜底已就绪。
- GitHub Pages 旧仓库（若含工价数据）需先处理泄露面（改为 private 或用干净历史 force-push 替换），再部署共享版。
