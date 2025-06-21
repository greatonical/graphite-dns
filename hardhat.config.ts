// hardhat.config.ts
import "@nomicfoundation/hardhat-toolbox";
import "hardhat-gas-reporter";
import "hardhat-contract-sizer";
import "solidity-coverage";
import "@typechain/hardhat";

import * as dotenv from "dotenv";
dotenv.config();

import { HardhatUserConfig } from "hardhat/config";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",

  solidity: {
    compilers: [
      {
        version: "0.8.28",
        settings: { optimizer: { enabled: true, runs: 200 } },
      },
    ],
  },

  networks: {
    hardhat: {
      // forking: {
      //   url: process.env.GRAPHITE_MAINNET_RPC_URL!,
      //   blockNumber: process.env.FORK_BLOCK_NUMBER
      //     ? Number(process.env.FORK_BLOCK_NUMBER)
      //     : undefined,
      // },
    },

        // an explicit forked network, only if you need it:
    forked: {
      url: process.env.GRAPHITE_TESTNET_RPC_URL!,
      chainId: 440017,
      forking: {
        url: process.env.GRAPHITE_TESTNET_RPC_URL!,
        blockNumber: process.env.FORK_BLOCK_NUMBER
          ? Number(process.env.FORK_BLOCK_NUMBER)
          : undefined,
      },
    },
    graphite: {
      url: process.env.GRAPHITE_MAINNET_RPC_URL,
      chainId: 440017,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
    graphiteTestnet: {
      url: process.env.GRAPHITE_TESTNET_RPC_URL,
      chainId: 54170,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
    },
  },

  etherscan: {
    apiKey: {
      graphite: process.env.GRAPITHESCAN_API_KEY || "",
      graphiteTestnet: process.env.GRAPITHESCAN_API_KEY || "",
    },
    customChains: [
      {
        network: "graphite",
        chainId: 440017,
        urls: {
          apiURL: "https://api.main.atgraphite.com/api",
          browserURL: "https://main.atgraphite.com",
        },
      },
      {
        network: "graphiteTestnet",
        chainId: 54170,
        urls: {
          apiURL: "https://api.test.atgraphite.com/api",
          browserURL: "https://test.atgraphite.com",
        },
      },
    ],
  },

  typechain: {
    outDir: "typechain",
    target: "ethers-v6",
  },

  paths: {
    sources: "contracts",
    tests: "test",
    cache: "cache",
    artifacts: "artifacts",
  },

  mocha: {
    timeout: 200_000,
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: "gas-report.txt",
    noColors: true,
  },

  contractSizer: {
    alphaSort: true,
    runOnCompile: true,
    disambiguatePaths: false,
  },
};

export default config;
