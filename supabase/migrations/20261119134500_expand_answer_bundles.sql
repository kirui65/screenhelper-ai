alter table public.screenhelper_payments
  drop constraint if exists screenhelper_payments_answers_check;

alter table public.screenhelper_payments
  add constraint screenhelper_payments_answer_bundle_check check (
    (answers = 50 and amount_kes = 25)
    or (answers = 100 and amount_kes = 50)
    or (answers = 250 and amount_kes = 125)
    or (answers = 500 and amount_kes = 250)
    or (answers = 1000 and amount_kes = 500)
  );

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
  update public.screenhelper_accounts set paid_answers = paid_answers + payment.answers where user_id = payment.user_id;
  return jsonb_build_object('settled', true, 'already_settled', false);
end;
$$;
