# Pump.fun Paper Sprint Bot

[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/oreo-sol/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/oreo-sol/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A paper-trading bot for the [Pump.fun Paper Sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) bounty on make.fun. One program at `main.ts` (Node 22), no real money, no network calls — it paper-trades pump.fun bonding curves on a 6-hour replay and is ranked by net PnL.

## Strategy: early-momentum rotation

Most pump.fun coins die fast and a few run hard, so the bot buys only coins that already show real buy pressure — several distinct buyers, net SOL flowing in, price rising and sitting near its recent high — starts small (0.15 SOL), adds into strength up to 0.45 SOL, cuts losers fast (18% stop), and lets winners run on a trailing stop (25% off the peak once up 10%). A hard max-hold of 1500 slots keeps positions rotating through many coins.

## Files

- `main.ts` — the strategy (entrypoint, run by the grader as `node /bot/main.ts`)
- `vendor/makefun-bot.ts` — the agent-fun/replay/v2 wire shim from the kit SDK (vendored, byte-identical)
- `LICENSE` — MIT

## Run it locally

Grade it against the kit's dev window with the kit CLI (from the unpacked kit directory):

```sh
node cli/makefun.mjs grade-local --kit . --bot <path-to-this-repo> --driver process
```
