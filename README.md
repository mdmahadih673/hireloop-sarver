# Hireloop API

## Environment

Copy `.env.example` to `.env` and configure the API credentials. `BETTER_AUTH_SECRET` must match the frontend's Better Auth secret; the API uses it to verify the signed session cookie before allowing job and application changes. Keep `.env` private and never commit it.

`FRONTEND_ORIGINS` accepts a comma-separated list of browser origins. The frontend's `/api/backend/*` route proxies requests to this API and forwards the authenticated session cookie.

## Run locally

Install dependencies with `npm install`, then start the API with `node index.js`. The frontend expects the API at `http://localhost:5000` unless `NEXT_PUBLIC_API_BASE_URL` is configured.

## Stripe webhook

Configure Stripe to send `checkout.session.completed` to `/stripe/webhook`, then set the webhook signing secret in `STRIPE_WEBHOOK_SECRET`.
