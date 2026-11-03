-- =====================================================================
-- 初始数据：从现有 H5 / Excel 基准提取，共 25 道工序 + 全局参数
-- 原值保留：时薪 27、宽放率 0.15、小数位 4
-- 注意：执行 seed.sql 前必须先执行 schema.sql
-- =====================================================================

-- 清空旧数据（可选，首次部署时无旧数据可忽略）
-- truncate table public.price_history restart identity cascade;
-- delete from public.processes;
-- delete from public.settings;

-- ---------- 全局参数（单行 id=1） ----------
insert into public.settings (id, default_hourly_wage, default_allowance_rate, decimal_places)
values (1, 27, 0.15, 4)
on conflict (id) do update set
  default_hourly_wage = excluded.default_hourly_wage,
  default_allowance_rate = excluded.default_allowance_rate,
  decimal_places = excluded.decimal_places;

-- ---------- 工序初始数据（已移除） ----------
-- 公开仓库不包含真实工序/工时数据。
-- 管理员登录后在「工序管理」中手动录入，或在私有环境执行 seed.sql 的完整版本。

