# Graphite DNS

A fully on‑chain, modular, and extensible Decentralized Naming Service (DNS) built on the Graphite Network. Names are represented as ERC‑721 NFTs in a core registry, with support for:

- **First‑Come** registrations (fixed‑price minting)  
- **Blind‑Auction** registrations (commit/reveal, Vickrey‑style)  
- **Subdomain** sales under parent names  
- **On‑chain Resolver** for text records (IPFS/Arweave metadata)  
- **Reverse Registrar** for address→name lookups  
- **EIP‑712 Meta‑Transfers** for gasless domain transfers  
- **Role‑Based Access Control**, pausing, and reentrancy protection  

---

## Table of Contents

1. [Architecture & Design](#architecture--design)  
2. [Contracts Overview](#contracts-overview)  
3. [Code Flow](#code-flow)  
4. [Directory Structure](#directory-structure)  
5. [Getting Started](#getting-started)  
   - [Prerequisites](#prerequisites)  
   - [Installation](#installation)  
   - [Configuration (.env)](#configuration-env)  
6. [Scripts & Commands](#scripts--commands)  
7. [Deployment](#deployment)  
8. [Testing](#testing)  
9. [Frontend Integration](#frontend-integration)  
10. [Security & Auditing](#security--auditing)  
11. [Contributing](#contributing)  
12. [License](#license)  

---

## Architecture & Design

```
   ┌───────────────────────────────────────────────────────────────┐
   │                          Frontend /                         │
   │                        off‑chain scripts                    │
   └───────────┬───────────────────┬──────────────────┬───────────┘
               │                   │                  │
               ▼                   ▼                  ▼
   ┌───────────────────┐  ┌───────────────────┐  ┌───────────────────┐
   │  AuctionRegistrar │  │SubdomainRegistrar│  │ReverseRegistrar    │
   └───────────────────┘  └───────────────────┘  └───────────────────┘
                 │                   │                  │
                 ▼                   ▼                  ▼
             ┌───────────────────────────────────────────────┐
             │           GraphiteDNSRegistry                │
             │  (ERC‑721 core registry & first‑come logic)  │
             └───────────────────────────────────────────────┘
                                ▲
                                │
                                ▼
                     ┌────────────────────┐
                     │  GraphiteResolver  │
                     └────────────────────┘
```

- **GraphiteDNSRegistry**: Core ERC‑721 registry with fixed‑price (`buyFixedPrice`) and generic `register(...)`, EIP‑712 meta‑transfer, expiry/grace logic, and role management.  
- **AuctionRegistrar**: Blind‑auction module (commit → reveal → finalize) that mints winners via `registry.register{value:…}`.  
- **SubdomainRegistrar**: Allows parent‑domain owners to set prices and sell subdomains.  
- **GraphiteResolver**: On‑chain text records keyed by node and record name.  
- **ReverseRegistrar**: Address→name reverse lookup.  

---

## Contracts Overview

### GraphiteDNSRegistry.sol

- **Roles**:  
  - `DEFAULT_ADMIN_ROLE`: full admin  
  - `REGISTRAR_ROLE`: allowed to mint (`register` entrypoint)  
  - `PAUSER_ROLE`: pause/unpause registry  
  - `RESOLVER_ROLE`: set text records  
- **Key functions**:  
  - `register(label, owner, duration, resolver, parent) payable`  
  - `setFixedPrice(label, price)`, `priceOf(label)`, `buyFixedPrice(label, resolver, duration)`  
  - `transferWithSig(node, from, to, nonce, deadline, signature)`  
- **Lifecycle**: enforce expirations, grace period, renewals  

### AuctionRegistrar.sol

- **Blind auction**:  
  - `startAuction(label, commitDuration, revealDuration)`  
  - `commitBid(label, commitment)`  
  - `revealBid(label, bid, salt) payable`  
  - `finalizeAuction(label, winner, duration, resolver, parent)`  
- Emits detailed events for UIs and indexing. For creating auctions.

### SubdomainRegistrar.sol

- **Subdomain sales under an existing parent node**:  
  - `setSubdomainPrice(parentNode, label, price)`  
  - `priceOfSubdomain(parentNode, label)`  
  - `buySubdomainFixedPrice(parentNode, label, resolver, duration)`  

### GraphiteResolver.sol

- **Text records**:  
  - `setText(node, key, value)`  
  - `text(node, key)`  

### ReverseRegistrar.sol

- **Reverse lookup**:  
  - `setReverse(name)`  
  - `getReverse(address)`  

---

## Code Flow

1. **Deploy Resolver** → exposes text + pause  
2. **Deploy Registry** with `.atgraphite` bootstrapped, passing resolver address  
3. **Deploy Modules** (Auction, Subdomain, Reverse) pointing to registry  
4. **Grant `REGISTRAR_ROLE`** on registry to Auction & Subdomain modules  
5. **First‑come**: Users call `registry.buyFixedPrice(...)` → refunds overpayments  
6. **Auction**: UIs manage commit/reveal off‑chain, then finalize mints into registry  
7. **Subdomain**: parent → set price, user → buy → registry registers subdomain token  
8. **Resolver & Reverse**: separate calls to set text or reverse name  

---

## Directory Structure

```
.
├── contracts/
│   ├── AuctionRegistrar.sol
│   ├── GraphiteDNSRegistry.sol
│   ├── GraphiteResolver.sol
│   ├── ReverseRegistrar.sol
│   └── SubdomainRegistrar.sol
├── scripts/
│   └── deploy.ts
├── test/
├── typechain/
├── artifacts/
├── hardhat.config.ts
├── package.json
├── tsconfig.json
└── README.md
```

---

## Getting Started

### Prerequisites

- Node.js ≥16  
- yarn, npm, or pnpm  
- Graphite RPC URLs & funded deployer key  

### Installation

```bash
git clone ... && cd graphite-dns
npm install
```

### Configuration (.env)

```dotenv
GRAPHITE_TESTNET_RPC_URL=...
GRAPHITE_MAINNET_RPC_URL=...
DEPLOYER_PRIVATE_KEY=0x...
GRAPITHESCAN_API_KEY=...
REPORT_GAS=true
COINMARKETCAP_API_KEY=...
```

---

## Scripts & Commands

- `npm run compile`  
- `npm run test`  
- `npm run gas-report`  
- `npm run coverage`  
- `npm run size`  
- `npm run deploy:graphiteTestnet`  
- `npm run deploy:graphite`  

---

## Deployment

**Local Hardhat**  
```bash
npx hardhat node
npm run deploy:graphiteTestnet --network localhost
```

**Graphite Testnet / Mainnet**  
```bash
npm run deploy:graphiteTestnet
npm run deploy:graphite
```

---

## Testing

```bash
npm run test
npm run coverage
npm run gas-report
```

---

## Frontend Integration

```ts
import { JsonRpcProvider, Web3Provider, Contract } from "ethers";
import RegistryABI from "../artifacts/.../GraphiteDNSRegistry.json";

const provider = new JsonRpcProvider(process.env.REACT_APP_GRAPHITE_RPC_URL);
const registry = new Contract(process.env.REACT_APP_REGISTRY_ADDRESS!, RegistryABI.abi, provider);

const signer    = new Web3Provider(window.ethereum).getSigner();
const regWrite  = registry.connect(signer);

const price     = await registry.priceOf("alice");
await regWrite.buyFixedPrice("alice", resolverAddr, duration, { value: price });
```

---

## Security & Auditing

- OpenZeppelin `AccessControl`, `ReentrancyGuard`, `Pausable`  
- EIP‑712 meta-transfers  
- Independent audit recommended  
- Fuzz & edge-case testing advised  

---

## Contributing

1. Fork & clone  
2. Create feature branch  
3. PR with tests & documentation  

---

## License

MIT © Graphite Network
