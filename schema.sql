-- ============================================================
-- Схема базы данных для Telegram Mini App CRM (v2)
-- Выполните этот скрипт в Supabase: Project -> SQL Editor -> New query -> Run
-- Если вы уже прогоняли v1 схему — сначала прочитайте MIGRATION.md
-- (внизу этого файла есть блок для миграции существующих данных).
-- ============================================================

create extension if not exists "pgcrypto";

-- Контакты / клиенты
create table if not exists contacts (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  phone text,
  telegram_username text,
  telegram_user_id text,
  email text,
  city text,
  direction text,                     -- направление: предприниматель / фрилансер / клиент+партнер / не знаю ...
  source text default 'вручную',      -- вручную / импорт / мероприятие / телефон
  status text default 'новый',        -- новый / в работе / клиент / отказ
  notes text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_contacts_phone on contacts (phone);
create index if not exists idx_contacts_tg on contacts (telegram_user_id);

-- ============================================================
-- Сделки = карточки воронки. У одного контакта может быть
-- несколько карточек — по одной на каждый проект.
-- ============================================================
create table if not exists deals (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  project text not null default 'MWR'
    check (project in ('MWR', 'Мафия', 'Нейросети', 'Переговоры')),
  stage text not null default 'новый клиент'
    check (stage in (
      'новый клиент',
      'первичное касание',
      'первичная встреча',
      'изучает материалы',
      'мероприятие',
      'повторная встреча',
      'первичная трёшка',
      'повторная трёшка',
      'ищет деньги',
      'на паузе',
      'регистрация'
    )),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists idx_deals_contact on deals (contact_id);
create index if not exists idx_deals_stage on deals (stage);
create index if not exists idx_deals_project on deals (project);

-- Задачи и встречи (встречи синхронизируются с Google Calendar)
create table if not exists tasks (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid references contacts(id) on delete set null,
  kind text not null default 'задача' check (kind in ('задача', 'встреча')),
  title text not null,
  location text,
  due_date timestamptz,
  duration_minutes integer default 30,
  completed boolean default false,
  google_event_id text,               -- id события в Google Calendar (для обновления/удаления)
  created_at timestamptz default now()
);

create index if not exists idx_tasks_contact on tasks (contact_id);
create index if not exists idx_tasks_due on tasks (due_date);

-- Мероприятия (создаём раньше touches, т.к. touches ссылается на events)
create table if not exists events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  event_date timestamptz,
  location text,
  created_at timestamptz default now()
);

-- Касания (история взаимодействий с клиентом)
create table if not exists touches (
  id uuid primary key default gen_random_uuid(),
  contact_id uuid not null references contacts(id) on delete cascade,
  type text not null default 'звонок/переписка первичная'
    check (type in (
      'звонок/переписка первичная',
      'звонок/переписка повторная',
      'первичная встреча',
      'повторная встреча',
      'мероприятие',
      'первичная трёшка',
      'повторная трёшка',
      'регистрация',
      'другое'
    )),
  event_id uuid references events(id) on delete set null,
  note text,
  created_at timestamptz default now()
);

create index if not exists idx_touches_contact on touches (contact_id);
create index if not exists idx_touches_type on touches (type);

-- Регистрации на мероприятия
create table if not exists event_registrations (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references events(id) on delete cascade,
  contact_id uuid references contacts(id) on delete set null,
  name text,
  phone text,
  telegram_username text,
  telegram_user_id text,
  referred_by text,       -- "Кто пригласил" — имя того, кто позвал
  will_come text,         -- "Точно сможешь прийти?": да, буду / скорее всего да / под вопросом
  bringing_guest text,    -- "Придёшь один(одна)?": да / уже пригласил(а) / подумаю кого позвать / нет
  registered_at timestamptz default now()
);

create index if not exists idx_regs_event on event_registrations (event_id);

-- ============================================================
-- Google Calendar: одна запись с токенами вашего аккаунта.
-- Эта таблица НЕ открыта для анонимного доступа (см. RLS ниже) —
-- к ней обращаются только Edge Functions через service role key.
-- ============================================================
create table if not exists google_tokens (
  id integer primary key default 1,
  connected_email text,
  refresh_token text,
  access_token text,
  access_token_expiry timestamptz,
  updated_at timestamptz default now(),
  constraint single_row check (id = 1)
);

-- ============================================================
-- На случай, если вы уже выполняли эту схему раньше (v2) и таблицы
-- уже существуют — "create table if not exists" их не тронет и новые
-- колонки не добавит. Эти команды безопасно дополнят существующие
-- таблицы (если колонка уже есть — ничего не произойдёт).
-- ============================================================
alter table contacts add column if not exists city text;
alter table contacts add column if not exists direction text;
alter table event_registrations add column if not exists referred_by text;
alter table event_registrations add column if not exists will_come text;
alter table event_registrations add column if not exists bringing_guest text;

-- Если touches уже существует с прежним набором типов ('касание' и т.д.),
-- старый CHECK нужно снять и поставить новый — иначе новые типы вставить
-- не получится:
--   alter table touches drop constraint if exists touches_type_check;
--   alter table touches add constraint touches_type_check check (type in (
--     'звонок/переписка первичная', 'звонок/переписка повторная',
--     'первичная встреча', 'повторная встреча', 'мероприятие',
--     'первичная трёшка', 'повторная трёшка', 'регистрация', 'другое'
--   ));

-- ============================================================
-- Row Level Security
-- ============================================================

alter table contacts enable row level security;
alter table deals enable row level security;
alter table tasks enable row level security;
alter table touches enable row level security;
alter table events enable row level security;
alter table event_registrations enable row level security;
alter table google_tokens enable row level security;

create policy "allow all - contacts" on contacts for all using (true) with check (true);
create policy "allow all - deals" on deals for all using (true) with check (true);
create policy "allow all - tasks" on tasks for all using (true) with check (true);
create policy "allow all - touches" on touches for all using (true) with check (true);
create policy "allow all - events" on events for all using (true) with check (true);
create policy "allow all - event_registrations" on event_registrations for all using (true) with check (true);

-- ВАЖНО: для google_tokens сознательно НЕ создаём policy.
-- При включённом RLS и отсутствии policy анонимный/публичный ключ
-- (anon key), которым пользуется мини-приложение, не может ни читать,
-- ни писать в эту таблицу. Доступ к ней есть только у Edge Functions
-- (они используют service role key, который обходит RLS). Так токены
-- Google никогда не попадают в браузер.

-- ============================================================
-- МИГРАЦИЯ С ПРЕДЫДУЩЕЙ ВЕРСИИ (если вы уже создавали старые
-- таблицы deals/touches/tasks с полями title/amount и старыми типами
-- касаний) — выполните это ПЕРЕД созданием таблиц выше, чтобы
-- убрать старые ограничения, либо просто удалите старые таблицы,
-- если тестовые данные не жалко:
--
--   drop table if exists event_registrations cascade;
--   drop table if exists events cascade;
--   drop table if exists touches cascade;
--   drop table if exists tasks cascade;
--   drop table if exists deals cascade;
--
-- После этого заново выполните весь скрипт целиком.

-- ============================================================
-- Обновление: напоминания о задачах в Telegram-бота (task-reminders)
-- Выполните это ПОСЛЕ основной схемы выше (можно просто добавить в конец
-- того же SQL-скрипта в Supabase SQL Editor и запустить весь файл заново —
-- "add column if not exists" ничего не сломает, если колонка уже есть).
-- ============================================================

alter table tasks add column if not exists reminder_sent boolean default false;

-- Настройки CRM: здесь храним chat_id владельца (вас) в Telegram, куда
-- Edge Function task-reminders будет слать напоминания о задачах.
-- Заполняется автоматически из мини-приложения при каждом открытии
-- (см. app.js -> init()), поэтому вручную ничего вписывать не нужно —
-- достаточно один раз открыть мини-апп в Telegram после этого обновления.
create table if not exists settings (
  id integer primary key default 1,
  owner_chat_id text,
  updated_at timestamptz default now(),
  constraint settings_single_row check (id = 1)
);

alter table settings enable row level security;
create policy "allow all - settings" on settings for all using (true) with check (true);
