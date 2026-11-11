# hardhat-gas-profile

A Hardhat 3 plugin that shows where each Solidity test's gas goes.

`hardhat test solidity --gas-profile` (or `hardhat test --gas-profile`) runs the tests as usual, then:

- prints a summary: tests by gas, functions by self gas, and each test's hottest call path;
- writes an HTML report to `<cache>/gas-profile/index.html`;
- writes one folded-stacks file per test to `<cache>/gas-profile/folded/`, which [speedscope](https://www.speedscope.app/), [inferno](https://github.com/jonhoo/inferno) and `flamegraph.pl` can open.

The profile is built from the call traces EDR already returns. A failing test is profiled too, and a profile that can't be written never changes the test result.

## Requirements

Hardhat 3.22.0 or later, the first release with the `includeTraces` option on `test solidity` ([NomicFoundation/hardhat#8824](https://github.com/NomicFoundation/hardhat/pull/8824)). With an older hardhat, `--gas-profile` stops with an error that says so; runs without the flag are unaffected.

## Install

```sh
npm install --save-dev hardhat-gas-profile
```

```ts
// hardhat.config.ts
import hardhatGasProfile from "hardhat-gas-profile";
import { defineConfig } from "hardhat/config";

export default defineConfig({
  plugins: [hardhatGasProfile],
});
```

## Notes

- `--gas-profile` can't be combined with `--coverage`: coverage instruments the contracts and changes their gas.
- With isolation on (`--gas-stats`, `--gas-stats-json`, or `isolate: true` in the test profile) each top-level call runs as its own transaction, so its gas includes that transaction's cost. The plugin warns when that's the case.
- Collecting traces for every test doesn't print them: what is printed still depends on the verbosity.

## Background

This started as a core proposal ([NomicFoundation/hardhat#8737](https://github.com/NomicFoundation/hardhat/issues/8737)). The Hardhat team suggested shipping it as a community plugin, with a small core change that lets plugins collect call traces.

## License

MIT
