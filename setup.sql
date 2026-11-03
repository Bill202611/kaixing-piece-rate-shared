-- =====================================================================
-- 浙江土畜凯兴计件单价系统 · 共享版 —— 一键安装脚本
-- 合并 schema.sql + seed.sql，可直接粘贴到 Supabase SQL Editor 执行
-- 幂等设计：可重复执行，不会因已存在而报错（除特别说明外）
--
-- 执行顺序：
--   1. 在 Supabase 新建项目
--   2. SQL Editor 中粘贴本文件并执行（创建表、函数、RLS、触发器、Realtime、初始数据）
--   3. Authentication → 关闭公开注册
--   4. Authentication → Users 添加管理员 → 复制 UID
--   5. SQL Editor 执行：insert into user_roles(user_id, role) values ('<UID>','admin');
-- =====================================================================

-- ---------- 扩展 ----------
create extension if not exists "pgcrypto";

-- ---------- 1. 用户角色表 ----------
create table if not exists public.user_roles (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  role      text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);
comment on table public.user_roles is '用户角色映射，由管理员在 Supabase 后台维护';

-- ---------- 2. 工序表 ----------
create table if not exists public.processes (
  id              uuid primary key default gen_random_uuid(),
  code            integer not null unique,
  category        text    not null,
  name            text    not null,
  operation_time  numeric(12,4) not null default 0,
  allowance_rate  numeric(12,6) not null default 0,
  hourly_wage     numeric(12,4) not null default 0,
  net_bag_time    numeric(12,4) not null default 0,
  remarks         text    not null default '',
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_processes_category on public.processes (category);
create index if not exists idx_processes_enabled  on public.processes (enabled);

-- ---------- 3. 全局参数表（单行） ----------
create table if not exists public.settings (
  id                      integer primary key default 1 check (id = 1),
  default_hourly_wage     numeric(12,4) not null default 27,
  default_allowance_rate  numeric(12,6) not null default 0.15,
  decimal_places          integer not null default 4,
  updated_at              timestamptz not null default now(),
  updated_by              uuid references auth.users (id)
);

-- ---------- 4. 改价历史表 ----------
create table if not exists public.price_history (
  id                bigserial primary key,
  process_id        uuid references public.processes (id) on delete set null,
  process_code      integer,
  process_name      text,
  field_name        text not null,
  old_value         text,
  new_value         text,
  changed_by        uuid references auth.users (id),
  changed_by_email  text,
  changed_at        timestamptz not null default now()
);
create index if not exists idx_price_history_process on public.price_history (process_id);
create index if not exists idx_price_history_time    on public.price_history (changed_at desc);

-- ---------- 权限函数 is_admin() ----------
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

-- ---------- 改价历史触发器 ----------
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

  if (tg_op = 'INSERT') then
    insert into public.price_history (process_id, process_code, process_name, field_name, old_value, new_value, changed_by, changed_by_email)
    values (new.id, new.code, new.name, 'create', null, '工序已创建', auth.uid(), v_email);
  end if;

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

-- ---------- RLS 策略 ----------
alter table public.user_roles    enable row level security;
alter table public.processes      enable row level security;
alter table public.settings       enable row level security;
alter table public.price_history  enable row level security;

drop policy if exists "user_roles_self_read" on public.user_roles;
create policy "user_roles_self_read" on public.user_roles
  for select using (auth.uid() = user_id);

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

drop policy if exists "settings_auth_read" on public.settings;
create policy "settings_auth_read" on public.settings
  for select using (auth.role() = 'authenticated');

drop policy if exists "settings_admin_update" on public.settings;
create policy "settings_admin_update" on public.settings
  for update using (public.is_admin()) with check (public.is_admin());

drop policy if exists "price_history_admin_read" on public.price_history;
create policy "price_history_admin_read" on public.price_history
  for select using (public.is_admin());

-- ---------- Realtime 发布（幂等：已发布则跳过） ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'processes'
  ) then
    alter publication supabase_realtime add table public.processes;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'settings'
  ) then
    alter publication supabase_realtime add table public.settings;
  end if;
end $$;

-- =====================================================================
-- 初始数据：全局参数（工序初始数据已从公开仓库移除）
-- =====================================================================

