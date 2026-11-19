# ScreenHelper AI

ScreenHelper captures one frame from the shared browser tab and sends it to a small server. The server calls Coarena's OpenAI-compatible vision API; the API key stays on the server and is never sent to the browser.

## Configure Supabase and Lipwa

1. Install dependencies with `npm ci` and authenticate the Supabase CLI with `npx supabase login`.
2. Create or select your Supabase project, then link it with `npx supabase link <project-ref>`. The initial production schema is versioned in [`supabase/migrations`](supabase/migrations); apply it with `npx supabase db push`.
3. Enable email/password sign-up in Supabase Auth. If email confirmation is enabled, new users must confirm before they can sign in.
4. For Google sign-in, create a Google OAuth client ID for a Web application. Set its authorized redirect URI to `https://<your-project-ref>.supabase.co/auth/v1/callback`, then enable Google in Supabase Auth > Providers and enter that client ID and secret.
5. In Supabase Auth URL Configuration, allow `http://localhost:3000/api/auth/google/callback` and `https://<your-render-host>/api/auth/google/callback` in production.
6. Create a Lipwa API key and select the receiving M-Pesa channel in the Lipwa dashboard.
7. Set the variables listed in `.env.example` in `.env`: the Coarena key, Supabase project URL plus publishable and secret keys, Lipwa API key and channel ID, and app URL. Use `http://localhost:3000` for `PUBLIC_BASE_URL` locally; use your public HTTPS app URL in production. The CLI-created database password is also stored as `SUPABASE_DB_PASSWORD` in the ignored local `.env` file.
8. Install Node.js 20 or newer, run `npm start`, and open `http://localhost:3000` in a recent desktop browser.
9. Create an account or sign in with email/password or Google, connect a browser tab, then ask your question.

Password reset uses an email OTP. In Supabase Auth > Email Templates > Reset Password, use `{{ .Token }}` in the message instead of a confirmation link. Configure the OTP expiry under Auth > Sign In / Providers; one hour or less is recommended. The user enters the code and new password in this app.

For free customer email delivery, Brevo's Free plan lists 300 email sends a day. Configure its SMTP credentials in Supabase Auth > SMTP and authenticate your sender domain in Brevo DNS first. Supabase's default sender is only for testing: it only sends to project organization members and is limited to 2 messages per hour.

The Lipwa callback must be reachable at `${PUBLIC_BASE_URL}/api/lipwa/webhook`. On successful callback, the server confirms the checkout directly against Lipwa before applying credits. The database settles each payment once, so duplicate callbacks do not add duplicate answer bundles.

New accounts get unlimited answers during the first two hours after account creation. After that, each successful KSh 25 payment adds 50 answers. Failed AI requests restore a consumed paid answer.

The default model is `gpt-6-luna`, which supports image inputs and is listed as a free-tier option by Coarena. Set `COARENA_MODEL` in `.env` to another image-capable model offered by Coarena. The server reads `.env` directly and has no runtime package dependencies. In production, set `NODE_ENV=production` so authentication cookies use the `Secure` attribute.

The screenshot and prompt are sent to Coarena for inference. Coarena's Model API documentation says it stores every prompt and reply. Do not submit sensitive information.
