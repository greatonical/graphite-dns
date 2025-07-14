// scripts/deploy.ts
import { ethers } from "hardhat";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", await deployer.getAddress());
  console.log("Account balance:", ethers.formatEther(await deployer.provider.getBalance(deployer.address)));

  // 1) Deploy GraphiteResolver first
  console.log("\n=== Deploying GraphiteResolver ===");
  const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
  
  // Note: GraphiteResolver now needs registry address, but we'll deploy registry first and then update
  // For now, deploy with zero address and update later
  const resolverTemp = await ResolverFactory.deploy(ethers.ZeroAddress);
  await resolverTemp.waitForDeployment();
  const tempResolverAddress = await resolverTemp.getAddress();
  console.log("Temporary GraphiteResolver deployed to:", tempResolverAddress);

  // 2) Deploy GraphiteDNSRegistry with temporary resolver
  console.log("\n=== Deploying GraphiteDNSRegistry ===");
  const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
  const registry = await RegistryFactory.deploy(tempResolverAddress);
  await registry.waitForDeployment();
  const registryAddress = await registry.getAddress();
  console.log("GraphiteDNSRegistry deployed to:", registryAddress);

  // 3) Deploy proper GraphiteResolver with registry address
  console.log("\n=== Deploying final GraphiteResolver ===");
  const resolver = await ResolverFactory.deploy(registryAddress);
  await resolver.waitForDeployment();
  const resolverAddress = await resolver.getAddress();
  console.log("Final GraphiteResolver deployed to:", resolverAddress);

  // 4) Deploy AuctionRegistrar
  console.log("\n=== Deploying AuctionRegistrar ===");
  const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
  const auction = await AuctionFactory.deploy(registryAddress);
  await auction.waitForDeployment();
  const auctionAddress = await auction.getAddress();
  console.log("AuctionRegistrar deployed to:", auctionAddress);

  // 5) Deploy SubdomainRegistrar
  console.log("\n=== Deploying SubdomainRegistrar ===");
  const SubdomainFactory = await ethers.getContractFactory("SubdomainRegistrar");
  const subdomain = await SubdomainFactory.deploy(registryAddress);
  await subdomain.waitForDeployment();
  const subdomainAddress = await subdomain.getAddress();
  console.log("SubdomainRegistrar deployed to:", subdomainAddress);

  // 6) Deploy ReverseRegistrar
  console.log("\n=== Deploying ReverseRegistrar ===");
  const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
  const reverse = await ReverseFactory.deploy(registryAddress);
  await reverse.waitForDeployment();
  const reverseAddress = await reverse.getAddress();
  console.log("ReverseRegistrar deployed to:", reverseAddress);

  // 7) Configure permissions
  console.log("\n=== Configuring Permissions ===");
  
  const registrarRole = await registry.REGISTRAR_ROLE();
  const resolverRole = await registry.RESOLVER_ROLE();
  
  // Grant REGISTRAR_ROLE to auction and subdomain contracts
  console.log("Granting REGISTRAR_ROLE to AuctionRegistrar...");
  await registry.grantRole(registrarRole, auctionAddress);
  
  console.log("Granting REGISTRAR_ROLE to SubdomainRegistrar...");
  await registry.grantRole(registrarRole, subdomainAddress);
  
  // Grant RESOLVER_ROLE to resolver contract
  console.log("Granting RESOLVER_ROLE to GraphiteResolver...");
  await registry.grantRole(resolverRole, resolverAddress);
  
  // Grant RESOLVER_ROLE to resolver contract in resolver contract itself
  const resolverRole2 = await resolver.RESOLVER_ROLE();
  console.log("Granting RESOLVER_ROLE in resolver contract...");
  await resolver.grantRole(resolverRole2, registryAddress);

  // 8) Set up initial configuration
  console.log("\n=== Initial Configuration ===");
  
  // Set duration multipliers for better pricing
  console.log("Setting duration multipliers...");
  await registry.setDurationMultiplier(1, 10000); // 1 year: 100%
  await registry.setDurationMultiplier(2, 9500);  // 2 years: 95%
  await registry.setDurationMultiplier(3, 9000);  // 3 years: 90%
  await registry.setDurationMultiplier(5, 8500);  // 5 years: 85%
  await registry.setDurationMultiplier(10, 8000); // 10 years: 80%

  // Set some example fixed prices for premium domains
  const premiumDomains = ["app", "web", "crypto", "nft", "defi"];
  const premiumPrice = ethers.parseEther("1.0"); // 1 ETH for premium domains
  
  console.log("Setting premium domain prices...");
  for (const domain of premiumDomains) {
    await registry.setFixedPrice(domain, premiumPrice);
    console.log(`Set ${domain}.atgraphite price to 1 ETH`);
  }

  // 9) Summary
  console.log("\n=== DEPLOYMENT SUMMARY ===");
  console.log("GraphiteDNSRegistry:", registryAddress);
  console.log("GraphiteResolver:", resolverAddress);
  console.log("AuctionRegistrar:", auctionAddress);
  console.log("SubdomainRegistrar:", subdomainAddress);
  console.log("ReverseRegistrar:", reverseAddress);
  
  console.log("\n=== ENVIRONMENT VARIABLES ===");
  console.log(`NEXT_PUBLIC_REGISTRY_ADDRESS=${registryAddress}`);
  console.log(`NEXT_PUBLIC_RESOLVER_ADDRESS=${resolverAddress}`);
  console.log(`NEXT_PUBLIC_AUCTION_ADDRESS=${auctionAddress}`);
  console.log(`NEXT_PUBLIC_SUBDOMAIN_ADDRESS=${subdomainAddress}`);
  console.log(`NEXT_PUBLIC_REVERSE_ADDRESS=${reverseAddress}`);

  console.log("\n=== VERIFICATION COMMANDS ===");
  const network = await ethers.provider.getNetwork();
  const networkName = network.name === "unknown" ? "localhost" : network.name;
  
  console.log(`npx hardhat verify --network ${networkName} ${registryAddress} ${resolverAddress}`);
  console.log(`npx hardhat verify --network ${networkName} ${resolverAddress} ${registryAddress}`);
  console.log(`npx hardhat verify --network ${networkName} ${auctionAddress} ${registryAddress}`);
  console.log(`npx hardhat verify --network ${networkName} ${subdomainAddress} ${registryAddress}`);
  console.log(`npx hardhat verify --network ${networkName} ${reverseAddress} ${registryAddress}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });