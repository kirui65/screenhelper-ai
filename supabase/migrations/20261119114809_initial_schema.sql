-- Run this in the Supabase SQL editor before starting the app.
create table if not exists public.screenhelper_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  trial_started_at timestamptz not null default now(),
  paid_answers integer not null default 0 check (paid_answers >= 0),
  created_at timestamptz not null default now()
);

create table if not exists public.screenhelper_payments (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  amount_kes integer not null check (amount_kes >= 10),
  answers integer not null check (answers = 50),
  status text not null default 'pending' check (status in ('pending', 'paid', 'failed')),
  checkout_id text unique,
  receipt text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

-- Keep historical purchases at their original price; settlement matches the
-- verified Lipwa amount to the amount saved on that specific purchase.
alter table public.screenhelper_payments
  drop constraint if exists screenhelper_payments_amount_kes_check;
alter table public.screenhelper_payments
  add constraint screenhelper_payments_amount_kes_check check (amount_kes >= 10);

alter table public.screenhelper_accounts enable row level security;
alter table public.screenhelper_payments enable row level security;
-- All account/billing reads and writes go through the Node server with a Supabase
-- secret key. No direct browser access is granted to these tables.
revoke all on public.screenhelper_accounts from anon, authenticated;
revoke all on public.screenhelper_payments from anon, authenticated;

create or replace function public.screenhelper_new_account()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.screenhelper_accounts(user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists screenhelper_auth_user_created on auth.users;
create trigger screenhelper_auth_user_created
  after insert on auth.users
  for each row execute function public.screenhelper_new_account();

create or replace function public.screenhelper_consume_answer(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account public.screenhelper_accounts%rowtype;
  trial_until timestamptz;
begin
  insert into public.screenhelper_accounts(user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into account from public.screenhelper_accounts where user_id = p_user_id for update;
  trial_until := account.trial_started_at + interval '2 hours';
  if now() < trial_until then
    return jsonb_build_object('allowed', true, 'plan', 'trial', 'trial_ends_at', trial_until,
      'trial_seconds_remaining', greatest(0, floor(extract(epoch from (trial_until - now())))::integer),
      'paid_answers', account.paid_answers);
  end if;
  if account.paid_answers > 0 then
    update public.screenhelper_accounts set paid_answers = paid_answers - 1 where user_id = p_user_id returning * into account;
    return jsonb_build_object('allowed', true, 'plan', 'paid', 'trial_ends_at', trial_until,
      'trial_seconds_remaining', 0, 'paid_answers', account.paid_answers);
  end if;
  return jsonb_build_object('allowed', false, 'plan', 'expired', 'trial_ends_at', trial_until,
    'trial_seconds_remaining', 0, 'paid_answers', 0);
end;
$$;

create or replace function public.screenhelper_account_status(p_user_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  account public.screenhelper_accounts%rowtype;
  trial_until timestamptz;
begin
  insert into public.screenhelper_accounts(user_id) values (p_user_id)
  on conflict (user_id) do nothing;
  select * into account from public.screenhelper_accounts where user_id = p_user_id;
  trial_until := account.trial_started_at + interval '2 hours';
  return jsonb_build_object(
    'trial_ends_at', trial_until,
    'trial_seconds_remaining', greatest(0, floor(extract(epoch from (trial_until - now())))::integer),
    'paid_answers', account.paid_answers,
    'can_ask', now() < trial_until or account.paid_answers > 0
  );
end;
$$;

create or replace function public.screenhelper_refund_answer(p_user_id uuid, p_plan text)
returns void language sql security definer set search_path = '' as $$
  update public.screenhelper_accounts set paid_answers = paid_answers + 1
  where user_id = p_user_id and p_plan = 'paid';
$$;

create or replace function public.screenhelper_settle_payment(
  p_payment_id uuid, p_checkout_id text, p_amount integer, p_receipt text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  payment public.screenhelper_payments%rowtype;
begin
  select * into payment from public.screenhelper_payments where id = p_payment_id for update;
  if not found then return jsonb_build_object('settled', false, 'reason', 'unknown_payment'); end if;
  if payment.amount_kes <> p_amount then
    return jsonb_build_object('settled', false, 'reason', 'amount_mismatch');
  end if;
  if payment.checkout_id is not null and payment.checkout_id <> p_checkout_id then
    return jsonb_build_object('settled', false, 'reason', 'checkout_mismatch');
  end if;
  if payment.status = 'paid' then return jsonb_build_object('settled', true, 'already_settled', true); end if;
  update public.screenhelper_payments
    set status = 'paid', checkout_id = p_checkout_id, receipt = p_receipt, paid_at = now()
    where id = p_payment_id;
  update public.screenhelper_accounts set paid_answers = paid_answers + 50 where user_id = payment.user_id;
  return jsonb_build_object('settled', true, 'already_settled', false);
end;
$$;

create or replace function public.screenhelper_fail_payment(p_payment_id uuid, p_checkout_id text)
returns void language sql security definer set search_path = '' as $$
  update public.screenhelper_payments set status = 'failed'
  where id = p_payment_id and status = 'pending'
    and (checkout_id is null or checkout_id = p_checkout_id);
$$;

create or replace function public.screenhelper_payment_status(p_payment_id uuid, p_user_id uuid)
returns jsonb language sql security definer set search_path = '' as $$
  select jsonb_build_object('status', p.status, 'created_at', p.created_at)
  from public.screenhelper_payments p where p.id = p_payment_id and p.user_id = p_user_id;
$$;

revoke all on function public.screenhelper_consume_answer(uuid) from public, anon, authenticated;
revoke all on function public.screenhelper_account_status(uuid) from public, anon, authenticated;
revoke all on function public.screenhelper_refund_answer(uuid, text) from public, anon, authenticated;
revoke all on function public.screenhelper_settle_payment(uuid, text, integer, text) from public, anon, authenticated;
revoke all on function public.screenhelper_fail_payment(uuid, text) from public, anon, authenticated;
revoke all on function public.screenhelper_payment_status(uuid, uuid) from public, anon, authenticated;
grant execute on function public.screenhelper_consume_answer(uuid) to service_role;
grant execute on function public.screenhelper_account_status(uuid) to service_role;
grant execute on function public.screenhelper_refund_answer(uuid, text) to service_role;
grant execute on function public.screenhelper_settle_payment(uuid, text, integer, text) to service_role;
grant execute on function public.screenhelper_fail_payment(uuid, text) to service_role;
grant execute on function public.screenhelper_payment_status(uuid, uuid) to service_role;
