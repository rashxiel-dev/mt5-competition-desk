# MT5 Competition Signal Desk

A **manual** signal advisor built for a specific MT5 trading competition's rules. This is a separate project from any other signal dashboard — it has its own server, its own Telegram bot/channel, and its own risk engine calibrated to this competition's rules rather than a fixed prop-challenge.

## This is NOT an Expert Advisor

The competition rules state **"EA's are not allowed."** This tool does not connect to MT5, does not place trades, and cannot place trades. It only:
- Watches XAU/USD and suggests signals (same 5-strategy engine as the other signal desk: EMA Cross, Pullback, S/R Bounce, Breakout, RSI Reversal)
- Sends you a Telegram message with the suggested entry, SL, TP, and lot size
- Tracks your *hypothetical* P&L against the competition's rules, assuming you took every signal

**You place every trade yourself, by hand, in your MT5 terminal.** Using this to auto-trade (e.g. wiring it to an actual EA or trade-copier) would break the competition's rules.

## Important limitation: no live floating P&L

The daily loss rule is "5%, including floating losses." This tool only knows about trades *it* suggested and that you've logged as won/lost/breakeven — it has no connection to your actual MT5 account, so it cannot see:
- Trades you took that didn't come from this tool
- The real-time floating (unrealized) P&L on your currently open positions

**You are responsible for watching your own MT5 terminal's equity against the 5% daily rule.** This dashboard's numbers are a planning aid, not a compliance guarantee.

## Setup

Same pattern as any other signal desk:

1. Create a **separate** Telegram bot via @BotFather (don't reuse the gold dashboard's bot, to keep competition traffic separate) and get its chat ID or channel ID the same way as before.
2. Get a Twelve Data API key (or reuse your existing one — the free tier's rate limits are shared across whatever uses the same key).
3. ```bash
   cd mt5-competition-desk
   npm install
   cp env.example.txt .env   # fill in your real keys
   npm start
   ```
4. Deploy to Render (or wherever) the same way as the gold dashboard — new Web Service, connect this repo, set the environment variables from `env.example.txt`, deploy.

## Adjusting the rules

Every competition rule is an environment variable in `env.example.txt` — if the rulebook changes (different account size, different lot caps, etc.), update the corresponding variable in Render and redeploy. No code changes needed for rule tweaks.

## What's tracked

- **Daily / total P&L** — percentage-based ($100k account → $5,000 daily cap, $10,000 total cap by default), auto-halts new signals once breached
- **Up to 5 open positions** — each tracked and auto-resolved independently against its own SL/TP, with breakeven-at-20-pips protection
- **Trade count** — capped at 50/day per the rules
- **Trading days** — counts distinct days you've logged at least one trade, toward the 5-day minimum
- **Commission** — $3/lot deducted from every resolved trade's P&L

## Not included (by design, to keep this focused)

- No daily PDF reports (the other dashboard has this; can be added here too if wanted)
- No TradingView embed or detailed chart-map visuals
- No per-visitor "My Account" personalization (this tool already tracks one account — yours)

Ask for any of these to be added if useful.
