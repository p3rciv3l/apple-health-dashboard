# cbum chart

A live chart of what I eat and how I lift. My agent keeps the log: I send it
photos of package labels and restaurant order pages, it writes the rows with
the numbers and where they came from, and the page updates itself.

![The macros chart](docs/assets/hero.png)

![Tap a day, switch the window, flip to the average](docs/assets/demo.gif)

| Day blow-up | Workout progress |
|---|---|
| ![One long day's items in a blow-up](docs/assets/blow-up.png) | ![Push / Pull / Legs over time](docs/assets/workout.png) |

Run your own: [docs/setup.md](docs/setup.md). The contract the agent logs
under: [FORMATTING.md](FORMATTING.md).

More: [technical reference](docs/technical.md) -
[data model](docs/data-model.md) - [design notes](docs/design.md) -
[running it as an agent](docs/agent-ops.md).

Apple Health (sleep, steps, scale, heart) is an optional add-on in
[PR 1](https://github.com/p3rciv3l/apple-health-dashboard/pull/1):
an iOS Shortcut posts samples to the worker, they land in a small database,
and a second chart page shows them. It carries its own setup notes.
