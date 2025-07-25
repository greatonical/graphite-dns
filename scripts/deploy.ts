import { ethers } from "hardhat";
import "@nomicfoundation/hardhat-ethers";

import { GraphiteDNSRegistry, GraphiteResolver, AuctionRegistrar, SubdomainRegistrar, ReverseRegistrar } from "../typechain";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

  // Deploy GraphiteResolver first (temporary)
  console.log("\n📋 Deploying GraphiteResolver (temporary)...");
  const ResolverFactory = await ethers.getContractFactory("GraphiteResolver");
  const tempResolver = await ResolverFactory.deploy(ethers.ZeroAddress);
  await tempResolver.waitForDeployment();
  console.log("Temp GraphiteResolver deployed to:", await tempResolver.getAddress());

  // Deploy GraphiteDNSRegistry
  console.log("\n🏛️  Deploying GraphiteDNSRegistry...");
  const RegistryFactory = await ethers.getContractFactory("GraphiteDNSRegistry");
  const registry = await RegistryFactory.deploy(await tempResolver.getAddress()) as GraphiteDNSRegistry;
  await registry.waitForDeployment();
  console.log("GraphiteDNSRegistry deployed to:", await registry.getAddress());

  // Deploy proper GraphiteResolver with registry address
  console.log("\n📋 Deploying GraphiteResolver...");
  const resolver = await ResolverFactory.deploy(await registry.getAddress()) as GraphiteResolver;
  await resolver.waitForDeployment();
  console.log("GraphiteResolver deployed to:", await resolver.getAddress());

  // Deploy AuctionRegistrar
  console.log("\n🏺 Deploying AuctionRegistrar...");
  const AuctionFactory = await ethers.getContractFactory("AuctionRegistrar");
  const auctionRegistrar = await AuctionFactory.deploy(await registry.getAddress()) as AuctionRegistrar;
  await auctionRegistrar.waitForDeployment();
  console.log("AuctionRegistrar deployed to:", await auctionRegistrar.getAddress());

  // Deploy SubdomainRegistrar
  console.log("\n🌐 Deploying SubdomainRegistrar...");
  const SubdomainFactory = await ethers.getContractFactory("SubdomainRegistrar");
  const subdomainRegistrar = await SubdomainFactory.deploy(await registry.getAddress()) as SubdomainRegistrar;
  await subdomainRegistrar.waitForDeployment();
  console.log("SubdomainRegistrar deployed to:", await subdomainRegistrar.getAddress());

  // Deploy ReverseRegistrar
  console.log("\n🔄 Deploying ReverseRegistrar...");
  const ReverseFactory = await ethers.getContractFactory("ReverseRegistrar");
  const reverseRegistrar = await ReverseFactory.deploy(await registry.getAddress()) as ReverseRegistrar;
  await reverseRegistrar.waitForDeployment();
  console.log("ReverseRegistrar deployed to:", await reverseRegistrar.getAddress());

  // Setup roles and permissions
  console.log("\n⚙️  Setting up roles and permissions...");
  
  const REGISTRAR_ROLE = ethers.keccak256(ethers.toUtf8Bytes("REGISTRAR_ROLE"));
  
  // Grant REGISTRAR_ROLE to registrars
  await registry.grantRole(REGISTRAR_ROLE, await auctionRegistrar.getAddress());
  console.log("✅ Granted REGISTRAR_ROLE to AuctionRegistrar");
  
  await registry.grantRole(REGISTRAR_ROLE, await subdomainRegistrar.getAddress());
  console.log("✅ Granted REGISTRAR_ROLE to SubdomainRegistrar");

  // Set reverse registrar in registry
  await registry.setReverseRegistrar(await reverseRegistrar.getAddress());
  console.log("✅ Set ReverseRegistrar in registry");

  // Set some example fixed prices
  console.log("\n💰 Setting example fixed prices...");
  await registry.setFixedPrice("premium", ethers.parseEther("10.0"));
  await registry.setFixedPrice("vip", ethers.parseEther("5.0"));
  await registry.setFixedPrice("elite", ethers.parseEther("2.0"));
  console.log("✅ Set fixed prices for premium domains");

  // Verification
  console.log("\n🔍 Verification...");
  const tldNode = await registry.TLD_NODE();
  const domain = await registry.getDomain(tldNode);
  console.log("TLD Node:", tldNode);
  console.log("TLD Owner:", domain.owner);
  console.log("TLD Label:", await registry.getLabel(tldNode));

  // Contract addresses summary
  console.log("\n📋 Deployment Summary:");
  console.log("=".repeat(50));
  console.log("GraphiteDNSRegistry:", await registry.getAddress());
  console.log("GraphiteResolver:", await resolver.getAddress());
  console.log("AuctionRegistrar:", await auctionRegistrar.getAddress());
  console.log("SubdomainRegistrar:", await subdomainRegistrar.getAddress());
  console.log("ReverseRegistrar:", await reverseRegistrar.getAddress());
  console.log("=".repeat(50));

  // Save addresses to file for frontend
  const addresses = {
    GraphiteDNSRegistry: await registry.getAddress(),
    GraphiteResolver: await resolver.getAddress(),
    AuctionRegistrar: await auctionRegistrar.getAddress(),
    SubdomainRegistrar: await subdomainRegistrar.getAddress(),
    ReverseRegistrar: await reverseRegistrar.getAddress(),
    TLD_NODE: tldNode,
    deployer: deployer.address,
    network: await ethers.provider.getNetwork().then((n:any) => n.name),
    chainId: await ethers.provider.getNetwork().then((n:any) => n.chainId),
    deployedAt: new Date().toISOString()
  };

  const fs = require('fs');
  fs.writeFileSync(
    `./deployments/${await ethers.provider.getNetwork().then((n:any) => n.name)}.json`,
    JSON.stringify(addresses, null, 2)
  );
  
  console.log(`\n💾 Deployment addresses saved to deployments/${await ethers.provider.getNetwork().then((n:any) => n.name)}.json`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });