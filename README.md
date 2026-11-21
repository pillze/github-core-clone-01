# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/pillze/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/pillze/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge: one Node 22 process serving git smart HTTP
(upload-pack protocol v2, receive-pack v0) for clone/fetch/push, the REST v3 API under
`/api/v3` (repositories, contents, issues, labels, comments, pull requests and merges),
the GraphQL v4 API at `/api/graphql`, and a Model Context Protocol endpoint at `/mcp`
(streamable HTTP, both protocol eras) — all from one in-memory store with no git binary,
no dependencies and no network at trial time.

## Run it

```sh
node --experimental-strip-types main.ts
```

The server binds an ephemeral port, registers it with the make.fun env at
`$MAKEFUN_ENV_URL/register`, serves the forge, and exits when the env reports done.

---

<sub>Entered on [make.fun](https://make.fun/?ref=chtbghga&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
