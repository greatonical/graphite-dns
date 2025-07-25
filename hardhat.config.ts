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
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
        },
      },
    ],
  },

  networks: {
    // Clean local blockchain for testing (no forking)
    hardhat: {
      chainId: 31337,
      gas: 30000000,
      gasPrice: 20000000000, // 20 gwei
      accounts: {
        count: 20,
        accountsBalance: "10000000000000000000000", // 10k ETH
      },
      // Remove forking configuration to use clean local blockchain
      // forking: {
      //   url: process.env.GRAPHITE_MAINNET_RPC_URL!,
      //   blockNumber: Number(process.env.FORK_BLOCK_NUMBER),
      // },
    },

    // For local testing with clean state
    localhost: {
      url: "http://127.0.0.1:8545",
      chainId: 31337,
    },

    // Forked network only when explicitly needed
    forked: {
      url: "http://127.0.0.1:8545",
      chainId: 440017,
      forking: {
        url: process.env.GRAPHITE_TESTNET_RPC_URL!,
        blockNumber: process.env.FORK_BLOCK_NUMBER
          ? Number(process.env.FORK_BLOCK_NUMBER)
          : undefined,
      },
    },

    // Production networks
    graphite: {
      url: process.env.GRAPHITE_MAINNET_RPC_URL,
      chainId: 440017,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      timeout: 60000,
      gasPrice: "auto",
    },

    graphiteTestnet: {
      url: process.env.GRAPHITE_TESTNET_RPC_URL,
      chainId: 54170,
      accounts: process.env.DEPLOYER_PRIVATE_KEY
        ? [process.env.DEPLOYER_PRIVATE_KEY]
        : [],
      timeout: 60000,
      gasPrice: "auto",
    },
  },

  etherscan: {
    apiKey: {
      graphite: process.env.GRAPITHESCAN_API_KEY || "",
      graphiteTestnet: process.env.GRAPITHESCAN_TESTNET_API_KEY || "",
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
    alwaysGenerateOverloads: false,
    externalArtifacts: [
      "node_modules/@openzeppelin/contracts/build/contracts/*.json",
    ],
  },

  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  mocha: {
    timeout: 120_000, // Reduced timeout
    bail: false, // Don't stop on first failure
  },

  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    outputFile: "gas-report.txt",
    noColors: true,
    showTimeSpent: true,
    showMethodSig: true,
  },

  contractSizer: {
    alphaSort: true,
    runOnCompile: false, // Only run when explicitly requested
    disambiguatePaths: false,
  },
};

export default config;
