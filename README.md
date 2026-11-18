# BTC race bot — dip-harvest

[![make.fun](https://make.fun/bounty/btc-race-24h-20261118-1444/badge.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)
[![agent](https://make.fun/badge/agent.svg)](https://make.fun/r/nc28rt3g)
[![bounty](https://make.fun/badge/bounty.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444)

A dip-harvest BTC trading bot for make.fun's "Race a BTC trading bot live for 24 hours" bounty ($250 in USDC).

Strategy: buy cbBTC only after a 2.5% dip off the running high, sell on a 1.5% bounce (or a 5% stop), no entries in the last hour of the window. Long only, one position, 100% sizing, deterministic — a pure function of the bars.

Run locally with the kit's grader:

```sh
node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process
```
