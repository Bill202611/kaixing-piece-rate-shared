-- =====================================================================
-- 浙江土畜凯兴计件单价系统 · 共享版数据库结构
-- 在 Supabase SQL Editor 中执行（先执行本文件，再执行 seed.sql）
-- 安全要点：
--   1. 前端只使用 anon public key，绝不把 service_role key 放入前端或仓库
--   2. 必须在 Supabase 后台关闭「公开注册」，否则任何人拿到 anon key 都可自行注册并读取工序数据
--   3. 账号由管理员在 Supabase Auth 后台创建，角色在 user_roles 表中维护
-- =====================================================================

-- ---------- 扩展 ----------
create extension if not exists "pgcrypto";

-- ---------- 1. 用户角色表 ----------
-- 角色：admin / viewer；viewer 只读，admin 可维护工序、参数、调价、查看历史
create table if not exists public.user_roles (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  role      text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);
comment on table public.user_roles is '用户角色映射，由管理员在 Supabase 后台维护';

-- ---------- 2. 工序表 ----------
create table if not exists public.processes (
  id              uuid primary key default gen_random_uuid(),
  code            integer not null unique,            -- 编号（唯一，可编辑）
  category        text    not null,                   -- 大工序
  name            text    not null,                   -- 工序/产品名称
  operation_time  numeric(12,4) not null default 0,  -- 作业时间(秒/把)
  allowance_rate  numeric(12,6) not null default 0,  -- 宽放率
  hourly_wage     numeric(12,4) not null default 0,  -- 时薪(元/H)
  net_bag_time    numeric(12,4) not null default 0,  -- 装网袋时间(秒/把)
  remarks         text    not null default '',        -- 备注
  enabled         boolean not null default true,      -- 启用状态
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_processes_category on public.processes (category);
create index if not exists idx_processes_enabled  on public.processes (enabled);
comment on table public.processes is '工序主数据，计件单价按公式实时计算，不存储计算结果';

-- ---------- 3. 全局参数表（单行） ----------
create table if not exists public.settings (
  id                      integer primary key default 1 check (id = 1),
  default_hourly_wage     numeric(12,4) not null default 27,   -- 默认时薪
  default_allowance_rate  numeric(12,6) not null default 0.15, -- 默认宽放率
  decimal_places          integer not null default 4,           -- 小数位数
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id)
);
comment on table public.settings is '全局计算参数，单行(id=1)，仅 admin 可改';

-- ---------- 4. 改价历史表 ----------
-- 由数据库触发器自动写入，前端不能伪造（无 INSERT 策略，仅 SECURITY DEFINER 触发器可写）
create table if not exists public.price_history (
  id                bigserial primary key,
  process_id        uuid references public.processes (id) on delete set null,
  process_code      integer,
  process_name      text,
  field_name        text not null,        -- 字段名：operation_time / allowance_rate / hourly_wage / net_bag_time / name / category / enabled / remarks
  old_value         text,
  new_value         text,
  changed_by        uuid references auth.users (id),
  changed_by_email  text,
  changed_at        timestamptz not null default now()
);
create index if not exists idx_price_history_process on public.price_history (process_id);
create index if not exists idx_price_history_time    on public.price_history (changed_at desc);
comment on table public.price_history is '工序改价历史，仅 admin 可读，触发器自动写入';

-- =====================================================================
-- 权限函数
-- =====================================================================
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.user_roles
    where user_id = auth.uid() and role = 'admin'
  );
$$;
comment on function public.is_admin() is '判断当前登录用户是否为 admin（绕过 RLS 读取 user_roles）';

-- =====================================================================
-- 改价历史触发器：工序字段变更时自动记录
-- =====================================================================
create or replace function public.log_process_change()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  select email into v_email from auth.users where id = auth.uid();

  if (tg_op = 'UPDATE') then
    if old.operation_time <> new.operation_time then
      insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
      values (new.id, new.code, new.name, 'operation_time', old.operation_time::text, new.operation_time::text, auth.uid(), v_email);
    end if;
    if old.allowance_rate <> new.allowance_rate then
      insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
      values (new.id, new.code, new.name, 'allowance_rate', old.allowance_rate::text, new.allowance_rate::text, auth.uid(), v_email);
    end if;
    if old.hourly_wage <> new.hourly_wage then
      insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
      values (new.id, new.code, new.name, 'hourly_wage', old.hourly_wage::text, new.hourly_wage::text, auth.uid(), v_email);
    end if;
    if old.net_bag_time <> new.net_bag_time then
      insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
      values (new.id, new.code, new.name, 'net_bag_time', old.net_bag_time::text, new.net_bag_time::text, auth.uid(), v_email);
    end if;
    if old.name <> new.name then
      insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
      values (new.id, new.code, new.name, 'name', old.name, new.name, auth.uid(), v_email);
    end if;
    if old.category <> new.category then
      insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
      values (new.id, new.code, new.name, 'category', old.category, new.category, auth.uid(), v_email);
    end if;
    if old.enabled <> new.enabled then
      insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
      values (new.id, new.code, new.name, 'enabled', old.enabled::text, new.enabled::text, auth.uid(), v_email);
    end if;
    if old.remarks <> new.remarks then
      insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
      values (new.id, new.code, new.name, 'remarks', old.remarks, new.remarks, auth.uid(), v_email);
    end if;
  end if;

  -- 新增时也记录一次，便于追溯
  if (tg_op = 'INSERT') then
    insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
    values (new.id, new.code, new.name, 'create', null, '工序已创建', auth.uid(), v_email);
  end if;

  -- 删除时记录
  if (tg_op = 'DELETE') then
    insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
    values (old.id, old.code, old.name, 'delete', '工序已存在', '工序已删除', auth.uid(), v_email);
  end if;

  if (tg_op = 'DELETE') then return old; else return new; end if;
end;
$$;

drop trigger if exists trg_process_change on public.processes;
create trigger trg_process_change
after insert or update or delete on public.processes
for each row execute function public.log_process_change();

-- ---------- updated_at 自动更新 ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_processes_touch on public.processes;
create trigger trg_processes_touch
before update on public.processes
for each row execute function public.touch_updated_at();

drop trigger if exists trg_settings_touch on public.settings;
create trigger trg_settings_touch
before update on public.settings
for each row execute function public.touch_updated_at();

-- =====================================================================
-- RLS（行级安全）策略
-- =====================================================================
alter table public.user_roles    enable row level security;
alter table public.processes      enable row level security;
alter table public.settings       enable row level security;
alter table public.price_history  enable row level security;

-- user_roles：每个登录用户只能看到自己的角色（admin 判断由 is_admin() 函数绕过 RLS）
drop policy if exists "user_roles_self_read" on public.user_roles;
create policy "user_roles_self_read" on public.user_roles
  for select using (auth.uid() = user_id);
-- user_roles 不设任何写策略：禁止前端写入，角色由管理员在 SQL 后台维护

-- processes：所有已登录用户可读；仅 admin 可增删改
drop policy if exists "processes_auth_read" on public.processes;
create policy "processes_auth_read" on public.processes
  for select using (auth.role() = 'authenticated');

drop policy if exists "processes_admin_insert" on public.processes;
create policy "processes_admin_insert" on public.processes
  for insert with check (public.is_admin());

drop policy if exists "processes_admin_update" on public.processes;
create policy "processes_admin_update" on public.processes
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "processes_admin_delete" on public.processes;
create policy "processes_admin_delete" on public.processes
  for delete using (public.is_admin());

-- settings：所有已登录用户可读；仅 admin 可改
drop policy if exists "settings_auth_read" on public.settings;
create policy "settings_auth_read" on public.settings
  for select using (auth.role() = 'authenticated');

drop policy if exists "settings_admin_update" on public.settings;
create policy "settings_admin_update" on public.settings
  for update using (public.is_admin()) with check (public.is_admin());
-- settings 不设 insert/delete 策略（单行 id=1，由 seed 初始化）

-- price_history：仅 admin 可读；无写策略（由 SECURITY DEFINER 触发器写入，绕过 RLS）
drop policy if exists "price_history_admin_read" on public.price_history;
create policy "price_history_admin_read" on public.price_history
  for select using (public.is_admin());

-- =====================================================================
-- Realtime 订阅授权（Supabase Realtime 需要显式发布表）
-- 执行后，前端可通过 supabase.channel 订阅 processes / settings 的变更
-- =====================================================================
alter publication supabase_realtime add table public.processes;
alter publication supabase_realtime add table public.settings;
