-- One Android app-scoped device ID may claim a free-trial account only once.
-- Deliberately no foreign key: deleting an account must not reset the trial.
create table if not exists public.screenhelper_device_claims (
  device_hash text primary key check (device_hash ~ '^[a-f0-9]{64}$'),
  owner_user_id uuid not null,
  claimed_at timestamptz not null default now()
);

alter table public.screenhelper_device_claims enable row level security;
revoke all on public.screenhelper_device_claims from public, anon, authenticated;

create or replace function public.screenhelper_claim_device(p_user_id uuid, p_device_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  owner_id uuid;
begin
  if p_device_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid device hash';
  end if;
  insert into public.screenhelper_device_claims(device_hash, owner_user_id)
    values (p_device_hash, p_user_id)
    on conflict (device_hash) do nothing;
  select owner_user_id into owner_id
    from public.screenhelper_device_claims where device_hash = p_device_hash;
  return jsonb_build_object('allowed', owner_id = p_user_id);
end;
$$;

revoke all on function public.screenhelper_claim_device(uuid, text) from public, anon, authenticated;
grant execute on function public.screenhelper_claim_device(uuid, text) to service_role;
