---
"hardhat-gas-profile": minor
---

First release. `hardhat test solidity --gas-profile` (or `hardhat test --gas-profile`) prints a gas summary per test, writes folded stacks for flamegraph tools and an HTML report. It needs a Hardhat release with the `includeTraces` option of `test solidity` ([NomicFoundation/hardhat#8824](https://github.com/NomicFoundation/hardhat/pull/8824)).
