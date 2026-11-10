import type { HardhatUserConfig } from "hardhat/config";

import gasProfile from "../../../src/index.js";

const config: HardhatUserConfig = {
  plugins: [gasProfile],
  solidity: "0.8.28",
};

export default config;
