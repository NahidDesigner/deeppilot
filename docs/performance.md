# Speed & performance

**How fast DeepPilot works depends mostly on your internet connection and your computer.** DeepPilot itself adds very little. This page explains where the time goes and how to make it faster.

## Where the time goes

Every step of a task is a round trip:

```
 read the page ──▶ send it to DeepSeek ──▶ model thinks ──▶ answer comes back ──▶ act on the page ──▶ page reacts / loads
   (your PC)          (your internet)        (DeepSeek)       (your internet)        (your PC)          (the website + internet)
```

A typical step takes **2–8 seconds**, and a task is usually 10–40 steps. So:

- **Slow or unstable internet** adds time to *every* step, twice: once sending the page, once receiving the answer. It also slows down every page that loads. This is usually the biggest factor.
- **Distance to DeepSeek's servers** matters: higher latency means a slower step, even on a fast connection.
- **The model's thinking time** varies with DeepSeek's load; busy hours can be slower.
- **Heavy websites** (Google Maps, PageSpeed Insights, LinkedIn, big dashboards) take a while to load and settle, and DeepPilot waits for them.
- **Your computer** reads the page, draws the element numbers and encodes screenshots. On an older or busy machine this adds up, especially with parallel tabs.

Rough guide: a simple task takes **1–3 minutes**, and a 10-item research job **5–15 minutes** with parallel tabs. The same job can be twice as fast on a good connection and a modern machine.

## Parallel tabs and your computer

Each working tab is a full browser tab. Expect roughly **150–400 MB of RAM per tab**, more on heavy sites, plus some CPU for screenshots.

| Your computer | Suggested **Max parallel tabs** |
|---|---|
| 4 GB RAM / older laptop | 1–2 (or switch automatic splitting off) |
| 8 GB RAM | 2–3 |
| 16 GB RAM | 4–6 (default is 4) |
| 32 GB RAM or more | 6–10 |

More tabs only help until your internet or computer becomes the bottleneck. If the fans get loud, the browser lags, or tabs start timing out, **lower the number**. You'll often finish *sooner*.

Parallel tabs don't change the cost much: it's the same work, done at the same time.

## Tips for a faster DeepPilot

1. **Use a stable connection.** A wired connection or strong Wi-Fi, and nothing heavy downloading or streaming at the same time.
2. **Keep laptops plugged in.** Battery saver and power-saving modes slow down background tabs.
3. **Close tabs you don't need**, especially video, games and heavy web apps.
4. **Leave "only send screenshots when the page changes" on** (Settings → Agent behaviour). It saves time and money.
5. **Be specific.** *"Open linkedin.com/mynetwork/invite-connect/connections"* is faster than *"find my connections"*.
6. **Use agents for big, repeated jobs.** Each stage starts fresh, so long runs don't slow down as the history grows.
7. **Pick the right number of parallel tabs** for your machine (see the table above).

## Measuring cost and speed yourself

The meter shows tokens and cost for every task. For developers, `npm run bench:cost` runs a scripted 24-step task against a mock server and reports tokens per request, cached versus uncached tokens, screenshots sent and an estimated cost. It's useful for checking that a change doesn't make DeepPilot more expensive.
