# Security Policy

## Trust model

XAU Scalper is **local-first**. The server binds to `127.0.0.1` only and has
**no authentication** by design — the only callers are processes on the same
machine. Two write endpoints (`/teo/propose`, `/teo/decision`) accept an
optional `x-teo-secret` header when `TEO_SHARED_SECRET` is set, but this is
defense-in-depth for the rare case where the host binds wider, not the normal
mode.

**Do not expose the server beyond localhost.** Setting `TEO_HOST=0.0.0.0`
without a reverse proxy + auth exposes both read and write endpoints to your
network.

## Reporting a vulnerability

This is a personal trading tool, not a hosted service. For a sensitive issue,
email the maintainer directly rather than opening a public issue.

## Secrets handling

- `.env.local` holds local secrets and is **gitignored**. Never commit it.
- A secret-free `.env.example` documents every supported variable. Copy it to
  `.env.local` and fill in locally.
- All P&L and trade-outcome values are derived server-side from stored data and
  are **never** accepted from a client — do not weaken this at any boundary.

## Known historical exposure

`.env.local` was once committed while the repo was public. The values were for
a Convex deployment and an email service the app no longer uses, but the
secrets **may still exist in old commits**. The file has since been
`git rm --cached`'d and stays out of the tree. **If those keys were ever live,
rotate them.** Treat any key found in git history as compromised.
