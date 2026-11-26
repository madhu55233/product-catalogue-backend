# Product catalogue backend

A database-free Node.js/TypeScript HTTP API. Catalogue reads fetch current data from [Fake Store API](https://fakestoreapi.com); enquiries use the [Resend email API](https://resend.com/docs/api-reference/emails/send-email). Neither products nor enquiries are stored locally.

## Run locally

Use Node.js 22.18+ and npm:

```sh
npm ci
npm test
npm run dev
```

Visit `http://localhost:3000/health`. For a compiled run use `npm run build` then `npm start`. The dev and start commands load an optional local `.env`; environment variables set by the host take precedence.

| Environment variable | Meaning |
| --- | --- |
| `PORT` | Listening port, default `3000`. |
| `UPSTREAM_TIMEOUT_MS` | Deadline per catalogue or email request (including response body), `1`-`60000`; default `5000`. |
| `RESEND_API_KEY` | Resend key with permission to send email. Keep it server-side. |
| `ENQUIRY_FROM` | Sender email address on a domain verified in Resend. |
| `ENQUIRY_TO` | Fixed sales inbox. The client cannot override the recipient. |
| `TRUST_PROXY_HOPS` | Number of reverse proxies in front of the app whose `X-Forwarded-For` entries are trusted, `0`-`10`; default `0` (rate limits use the socket peer). See Deploy step 4. |

Set all three email variables or omit all three. With none, browsing works and valid enquiries return `503`; partial or invalid configuration prevents startup.

## API

All application responses are JSON. Successful reads return `200`. Query values must be URL-encoded; unknown or repeated query parameters are rejected.

CORS currently allows all origins (`Access-Control-Allow-Origin: *`) without credentials. Browser clients can make GET/HEAD and JSON POST requests; OPTIONS preflights return an empty `204` without consuming enquiry attempts. The allowed request header is `Content-Type`; `Retry-After`, `RateLimit`, and `RateLimit-Policy` are exposed to browser code. Do not use `credentials: "include"`. This intentionally permits any website to call the API; restrict origins before adding cookie-based authentication. CORS does not resolve upstream service blocks or configure email delivery.

| Method and path | Successful response |
| --- | --- |
| `GET /health` | `{"status":"ok"}`; process liveness, not an upstream probe. |
| `GET /api/categories` | Array of category names (strings). |
| `GET /api/products` | Product array in upstream order. Optional `category` filters by exact category name (1-100 trimmed characters). |
| `GET /api/products/featured` | Up to five products by rating descending, then review count descending, then ID ascending. |
| `GET /api/products/search?q=bag` | Products whose **title** contains `q`, case-insensitive. Requires 1-100 trimmed characters. No matches return `[]`. Debounce calls when searching as the user types. |
| `GET /api/products/:id` | One product. ID must be a positive safe integer in decimal notation without leading zeros. |
| `POST /api/enquiries` | `202` with `{"status":"accepted","id":"<provider UUID>"}` only after Resend accepts the request. This is **not** a delivery confirmation. |

Example product shape:

```json
{"id":1,"title":"Day pack","price":39.95,"category":"bags","description":"Small backpack","image":"https://example.org/pack.png","rating":{"rate":4.5,"count":20}}
```

Example enquiry (sends real mail when configured):

```sh
curl -i http://localhost:3000/api/enquiries \
  -H 'Content-Type: application/json' \
  -d '{"name":"Buyer","email":"buyer@example.org","message":"Is this in stock?","productId":1}'
```

Required fields: `name` (1-100 trimmed characters), `email` (valid address, max 254), `message` (1-3000 trimmed characters). Optional `productId` is a positive integer reference, not a stock check. Extra fields are rejected. Messages are sent as plain text; the buyer is the reply-to address.

Errors use `{"error":"..."}`: `400` invalid input or malformed JSON; `404` unknown route or missing product; `413` body exceeds 32 KiB; `415` unsupported content type/encoding; `429` rate limit (respect `Retry-After`); `502` upstream failure or invalid response; `503` email disabled; `504` upstream deadline exceeded. The cause of each `502`/`504`, such as `fakestoreapi.com responded 403 (Cloudflare challenge)`, is logged server-side and never sent to clients. An email timeout leaves acceptance unknown; check Resend before retrying to avoid duplicates. There is no automatic retry or mock email fallback.

## Deploy

1. Create a Node web service on your host with Node 22.18+ and outbound HTTPS access to `fakestoreapi.com` and `api.resend.com`. No database, migrations, or volumes are needed. Fake Store's Cloudflare protection challenges requests from some cloud hosts, including Render; there every catalogue route returns `502`. To check a host, run `curl -s -o /dev/null -w '%{http_code}\n' https://fakestoreapi.com/products` from it and expect `200` (don't use `curl -I`: Cloudflare challenges HEAD requests even where GET works).
2. Use `npm ci --include=dev && npm run build` as the build command and `npm start` as the start command. Deploy the compiled `dist` and production dependencies if using separate build and runtime stages.
3. Supply the environment variables above using the host's secret manager. The service binds to `0.0.0.0` on the configured port. Terminate TLS at the host/proxy and use `/health` for health checks.
4. API limits are 120 requests/minute per client IP, with an additional 5 attempts/minute for enquiries. Counters are in memory per process and reset on restart. Behind proxies (Render, Heroku, a load balancer), set `TRUST_PROXY_HOPS` to exactly the number of proxies that append to `X-Forwarded-For`: too low and all visitors share one limit (express-rate-limit logs `ERR_ERL_UNEXPECTED_X_FORWARDED_FOR`); too high and clients can dodge limits by sending a fake `X-Forwarded-For`. Confirm the value after deploying by checking that the limiter keys on your own public IP, including when you send a fake `X-Forwarded-For`. For multiple replicas, enforce shared limits at the ingress.
5. Smoke-test `/api/categories` and `/api/products/1`. For email, send a controlled enquiry to your real sales inbox, verify its provider ID in Resend, then confirm receipt separately. Automated tests use isolated HTTP fixtures and do not send mail.
